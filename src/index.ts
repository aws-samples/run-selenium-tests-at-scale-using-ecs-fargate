import * as applicationautoscaling from '@aws-cdk/aws-applicationautoscaling';
import * as cloudwatch from '@aws-cdk/aws-cloudwatch';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as cdk from '@aws-cdk/core';

// Customizable construct inputs
export interface ISeleniumGridProps {
  // VPC
  readonly vpc?: ec2.IVpc;

  // Selenium version to pull in, ex:3.141.59
  readonly seleniumVersion?: string;

  // Memory settings for hub and chrome fargate nodes, ex: 512
  readonly memory?: number;

  // CPU settings for hub and chrome fargate nodes, ex: 256
  readonly cpu?: number;

  // Selenium NODE_MAX_INSTANCES pointing to number of instances of same version of browser that can run in node, ex: 5
  readonly seleniumNodeMaxInstances?: number;

  // Selenium NODE_MAX_SESSION pointing to number of browsers (Any browser and version) that can run in parallel at a time in node, ex: 5
  readonly seleniumNodeMaxSessions?: number;

  // Auto-scale minimum number of instances
  readonly minInstances?: number;

  // Auto-scale maximum number of instances
  readonly maxInstances?: number;
}

export interface IResourceDefinitionProps{
  cluster: ecs.Cluster;
  stack: cdk.Construct;
  loadBalancer: elbv2.ApplicationLoadBalancer;
  securityGroup: ec2.SecurityGroup;
  identifier: string;
  minInstances: number;
  maxInstances: number;
}

export interface IServiceDefinitionProps{
  resource: IResourceDefinitionProps;
  image: string;
  env: {[key: string]: string};
  readonly entryPoint?: string[];
  readonly command?: string[];
}

export interface IScalingPolicyDefinitionProps{
  stack: cdk.Construct;
  serviceName: string;
  clusterName: string;
  identifier: string;
  minInstances: number;
  maxInstances: number;
}

export class SeleniumGridConstruct extends cdk.Construct {

  readonly vpc: ec2.IVpc;
  readonly seleniumVersion: string;
  readonly memory: number;
  readonly cpu: number;
  readonly seleniumNodeMaxInstances: number;
  readonly seleniumNodeMaxSessions: number;
  readonly minInstances: number;
  readonly maxInstances: number;

  constructor(scope: cdk.Construct, id: string, props: ISeleniumGridProps = {}) {
    super(scope, id);

    // Create new VPC if it doesnt exist
    this.vpc = props.vpc ?? new ec2.Vpc(this, 'Vpc', { natGateways: 1 });
    this.seleniumVersion = props.seleniumVersion ?? '3.141.59';
    this.memory = props.memory ?? 512;
    this.cpu = props.cpu ?? 256;
    this.seleniumNodeMaxInstances = props.seleniumNodeMaxInstances ?? 5;
    this.seleniumNodeMaxSessions = props.seleniumNodeMaxSessions ?? 5;
    this.minInstances = props.minInstances ?? 1;
    this.maxInstances = props.maxInstances ?? 10;

    // Cluster
    const cluster = new ecs.Cluster(this, 'cluster', {
      vpc: this.vpc,
      containerInsights: true
    });

    // Setup capacity providers and default strategy for cluster
    const cfnEcsCluster = cluster.node.defaultChild as ecs.CfnCluster;
    cfnEcsCluster.capacityProviders = ['FARGATE', 'FARGATE_SPOT'];
    cfnEcsCluster.defaultCapacityProviderStrategy = [{
      capacityProvider: 'FARGATE',
      weight: 1,
      base: 4,
    }, {
      capacityProvider: 'FARGATE_SPOT',
      weight: 4,
    }];

    // Create security group and add inbound and outbound traffic ports
    var securityGroup = new ec2.SecurityGroup(this, 'security-group-selenium', {
      vpc: cluster.vpc,
      allowAllOutbound: true,
    });

    // Open up port 4444 and 5555 for execution
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(4444), 'Port 4444 for inbound traffic');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5555), 'Port 5555 for inbound traffic');

    // Setup Load balancer & register targets
    var loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'app-lb', {
      vpc: this.vpc,
      internetFacing: true,
    });
    loadBalancer.addSecurityGroup(securityGroup);

    // Register SeleniumHub resources
    this.createHubResources({
      cluster: cluster,
      identifier: 'hub',
      loadBalancer: loadBalancer,
      securityGroup: securityGroup,
      stack: this,
      maxInstances: this.maxInstances,
      minInstances: this.minInstances     
    });

    // Register Chrome node resources
    this.createBrowserResource({
      cluster: cluster,
      identifier: 'chrome',
      loadBalancer: loadBalancer,
      securityGroup: securityGroup,
      stack: this,
      maxInstances: this.maxInstances,
      minInstances: this.minInstances
    }, 'selenium/node-chrome');

    // Register Firefox node resources
    this.createBrowserResource({
      cluster: cluster,
      identifier: 'firefox',
      loadBalancer: loadBalancer,
      securityGroup: securityGroup,
      stack: this,
      maxInstances: this.maxInstances,
      minInstances: this.minInstances
    }, 'selenium/node-firefox');

    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      exportName: 'Selenium-Hub-DNS',
      value: loadBalancer.loadBalancerDnsName,
    });
  }

  createHubResources(options: IResourceDefinitionProps) {
    var service = this.createService({
      resource: options,
      env: {
        GRID_BROWSER_TIMEOUT: '200000',
        GRID_TIMEOUT: '180',
        SE_OPTS: '-debug',
      },
      image: 'selenium/hub:'+this.seleniumVersion,
    });

    // Create autoscaling policy
    this.createScalingPolicy({
      clusterName: options.cluster.clusterName,
      serviceName: service.serviceName,
      identifier: options.identifier,
      stack: options.stack,
      minInstances: options.minInstances,
      maxInstances: options.maxInstances
    });

    // Default target routing for 4444 so webdriver client can connect to
    const listener = options.loadBalancer.addListener('Listener', { port: 4444, protocol: elbv2.ApplicationProtocol.HTTP });
    service.registerLoadBalancerTargets({
      containerName: 'selenium-hub-container',
      containerPort: 4444,
      newTargetGroupId: 'ECS',
      protocol: ecs.Protocol.TCP,
      listener: ecs.ListenerConfig.applicationListener(listener, {
        protocol: elbv2.ApplicationProtocol.HTTP,
        port: 4444,
        targets: [service],
      }),
    });
  }

  createBrowserResource(options: IResourceDefinitionProps, image: string) {

    // Env parameters configured to connect back to selenium hub when new nodes gets added
    var service = this.createService({
      resource: options,
      env: {
        HUB_PORT_4444_TCP_ADDR: options.loadBalancer.loadBalancerDnsName,
        HUB_PORT_4444_TCP_PORT: '4444',
        NODE_MAX_INSTANCES: this.seleniumNodeMaxInstances.toString(),
        NODE_MAX_SESSION: this.seleniumNodeMaxSessions.toString(),
        SE_OPTS: '-debug',
        shm_size: '512',
      },
      image: image+':'+this.seleniumVersion,
      entryPoint: ['sh', '-c'],
      command: ["PRIVATE=$(curl -s http://169.254.170.2/v2/metadata | jq -r '.Containers[1].Networks[0].IPv4Addresses[0]') ; export REMOTE_HOST=\"http://$PRIVATE:5555\" ; /opt/bin/entry_point.sh"],
    });

    // Create autoscaling policy
    this.createScalingPolicy({
      clusterName: options.cluster.clusterName,
      serviceName: service.serviceName,
      identifier: options.identifier,
      stack: options.stack,
      minInstances: options.minInstances,
      maxInstances: options.maxInstances
    });
  }

  createService(options: IServiceDefinitionProps): ecs.FargateService {
    const stack = options.resource.stack;
    const identiifer = options.resource.identifier;
    const cluster = options.resource.cluster;
    const securityGroup = options.resource.securityGroup;

    // Task and container definition
    const taskDefinition = new ecs.FargateTaskDefinition(stack, 'selenium-'+identiifer+'-task-def',{
      memoryLimitMiB: this.memory,
      cpu: this.cpu
    });
    const containerDefinition = taskDefinition.addContainer('selenium-'+identiifer+'-container', {
      image: ecs.ContainerImage.fromRegistry(options.image),
      memoryLimitMiB: this.memory,
      cpu: this.cpu,
      environment: options.env,
      essential: true,
      logging: new ecs.AwsLogDriver({
        streamPrefix: 'selenium-'+identiifer+'-logs',
      }),
      entryPoint: options.entryPoint,
      command: options.command,
    });

    // Port mapping
    containerDefinition.addPortMappings({
      containerPort: 4444,
      hostPort: 4444,
      protocol: ecs.Protocol.TCP,
    });

    // Setup Fargate service
    return new ecs.FargateService(stack, 'selenium-'+identiifer+'-service', {
      cluster: cluster,
      taskDefinition: taskDefinition,
      minHealthyPercent: 75,
      maxHealthyPercent: 100,      
      securityGroups: [securityGroup],
    });
  }

  createScalingPolicy(options: IScalingPolicyDefinitionProps) {
    const serviceName = options.serviceName;
    const clusterName = options.clusterName;
    const identifier = options.identifier;
    const stack = options.stack;

    // Scaling set on ECS service level
    const target = new applicationautoscaling.ScalableTarget(stack, 'selenium-scalableTarget-'+identifier, {
      serviceNamespace: applicationautoscaling.ServiceNamespace.ECS,
      maxCapacity: options.maxInstances,
      minCapacity: options.minInstances,
      resourceId: 'service/'+clusterName+'/'+serviceName,
      scalableDimension: 'ecs:service:DesiredCount',    
    });

    // Metrics to listen
    const workerUtilizationMetric = new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName: 'CPUUtilization',
      statistic: 'max',
      period: cdk.Duration.minutes(1),
      dimensions: {
        ClusterName: clusterName,
        ServiceName: serviceName,
      },
    });

    // Define Scaling policies (scale-in and scale-out)
    // Remove one instance if CPUUtilization is less than 30%,
    // Add three instance if the CPUUtilization is greater than 70%    
    target.scaleOnMetric('step-metric-scaling-'+identifier, {
      metric: workerUtilizationMetric,          
      adjustmentType: applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,      
      scalingSteps: [
        { upper: 30, change: -1 },
        { lower: 80, change: +3 },
      ],    
      cooldown: cdk.Duration.seconds(180),      
    }); 
  }
}