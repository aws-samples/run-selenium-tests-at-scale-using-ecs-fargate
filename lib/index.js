"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeleniumGridConstruct = void 0;
const applicationautoscaling = require("@aws-cdk/aws-applicationautoscaling");
const cloudwatch = require("@aws-cdk/aws-cloudwatch");
const ec2 = require("@aws-cdk/aws-ec2");
const ecs = require("@aws-cdk/aws-ecs");
const elbv2 = require("@aws-cdk/aws-elasticloadbalancingv2");
const cdk = require("@aws-cdk/core");
class SeleniumGridConstruct extends cdk.Construct {
    constructor(scope, id, props = {}) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        super(scope, id);
        // Create new VPC if it doesnt exist
        this.vpc = (_a = props.vpc) !== null && _a !== void 0 ? _a : new ec2.Vpc(this, 'Vpc', { natGateways: 1 });
        this.seleniumVersion = (_b = props.seleniumVersion) !== null && _b !== void 0 ? _b : '3.141.59';
        this.memory = (_c = props.memory) !== null && _c !== void 0 ? _c : 512;
        this.cpu = (_d = props.cpu) !== null && _d !== void 0 ? _d : 256;
        this.seleniumNodeMaxInstances = (_e = props.seleniumNodeMaxInstances) !== null && _e !== void 0 ? _e : 5;
        this.seleniumNodeMaxSessions = (_f = props.seleniumNodeMaxSessions) !== null && _f !== void 0 ? _f : 5;
        this.minInstances = (_g = props.minInstances) !== null && _g !== void 0 ? _g : 1;
        this.maxInstances = (_h = props.maxInstances) !== null && _h !== void 0 ? _h : 10;
        // Cluster
        const cluster = new ecs.Cluster(this, 'cluster', {
            vpc: this.vpc,
            containerInsights: true
        });
        // Setup capacity providers and default strategy for cluster
        const cfnEcsCluster = cluster.node.defaultChild;
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
    createHubResources(options) {
        var service = this.createService({
            resource: options,
            env: {
                GRID_BROWSER_TIMEOUT: '200000',
                GRID_TIMEOUT: '180',
                SE_OPTS: '-debug',
            },
            image: 'selenium/hub:' + this.seleniumVersion,
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
    createBrowserResource(options, image) {
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
            image: image + ':' + this.seleniumVersion,
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
    createService(options) {
        const stack = options.resource.stack;
        const identiifer = options.resource.identifier;
        const cluster = options.resource.cluster;
        const securityGroup = options.resource.securityGroup;
        // Task and container definition
        const taskDefinition = new ecs.FargateTaskDefinition(stack, 'selenium-' + identiifer + '-task-def', {
            memoryLimitMiB: this.memory,
            cpu: this.cpu
        });
        const containerDefinition = taskDefinition.addContainer('selenium-' + identiifer + '-container', {
            image: ecs.ContainerImage.fromRegistry(options.image),
            memoryLimitMiB: this.memory,
            cpu: this.cpu,
            environment: options.env,
            essential: true,
            logging: new ecs.AwsLogDriver({
                streamPrefix: 'selenium-' + identiifer + '-logs',
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
        return new ecs.FargateService(stack, 'selenium-' + identiifer + '-service', {
            cluster: cluster,
            taskDefinition: taskDefinition,
            minHealthyPercent: 75,
            maxHealthyPercent: 100,
            securityGroups: [securityGroup],
        });
    }
    createScalingPolicy(options) {
        const serviceName = options.serviceName;
        const clusterName = options.clusterName;
        const identifier = options.identifier;
        const stack = options.stack;
        // Scaling set on ECS service level
        const target = new applicationautoscaling.ScalableTarget(stack, 'selenium-scalableTarget-' + identifier, {
            serviceNamespace: applicationautoscaling.ServiceNamespace.ECS,
            maxCapacity: options.maxInstances,
            minCapacity: options.minInstances,
            resourceId: 'service/' + clusterName + '/' + serviceName,
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
        target.scaleOnMetric('step-metric-scaling-' + identifier, {
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
exports.SeleniumGridConstruct = SeleniumGridConstruct;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsOEVBQThFO0FBQzlFLHNEQUFzRDtBQUN0RCx3Q0FBd0M7QUFDeEMsd0NBQXdDO0FBQ3hDLDZEQUE2RDtBQUM3RCxxQ0FBcUM7QUF3RHJDLE1BQWEscUJBQXNCLFNBQVEsR0FBRyxDQUFDLFNBQVM7SUFXdEQsWUFBWSxLQUFvQixFQUFFLEVBQVUsRUFBRSxRQUE0QixFQUFFOztRQUMxRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLG9DQUFvQztRQUNwQyxJQUFJLENBQUMsR0FBRyxTQUFHLEtBQUssQ0FBQyxHQUFHLG1DQUFJLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFLEVBQUUsV0FBVyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDckUsSUFBSSxDQUFDLGVBQWUsU0FBRyxLQUFLLENBQUMsZUFBZSxtQ0FBSSxVQUFVLENBQUM7UUFDM0QsSUFBSSxDQUFDLE1BQU0sU0FBRyxLQUFLLENBQUMsTUFBTSxtQ0FBSSxHQUFHLENBQUM7UUFDbEMsSUFBSSxDQUFDLEdBQUcsU0FBRyxLQUFLLENBQUMsR0FBRyxtQ0FBSSxHQUFHLENBQUM7UUFDNUIsSUFBSSxDQUFDLHdCQUF3QixTQUFHLEtBQUssQ0FBQyx3QkFBd0IsbUNBQUksQ0FBQyxDQUFDO1FBQ3BFLElBQUksQ0FBQyx1QkFBdUIsU0FBRyxLQUFLLENBQUMsdUJBQXVCLG1DQUFJLENBQUMsQ0FBQztRQUNsRSxJQUFJLENBQUMsWUFBWSxTQUFHLEtBQUssQ0FBQyxZQUFZLG1DQUFJLENBQUMsQ0FBQztRQUM1QyxJQUFJLENBQUMsWUFBWSxTQUFHLEtBQUssQ0FBQyxZQUFZLG1DQUFJLEVBQUUsQ0FBQztRQUU3QyxVQUFVO1FBQ1YsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsT0FB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RUFBRSxXQUFXO2dCQUN4QixXQUFXLEVBQUUsV0FBVzthQUN6QjtTQUNGLENBQUMsQ0FBQztRQUVILG1EQUFtRDtRQUNuRCwwREFBMEQ7UUFDMUQsbUVBQW1FO1FBQ25FLE1BQU0sQ0FBQyxhQUFhLENBQUMsc0JBQXNCLEdBQUMsVUFBVSxFQUFFO1lBQ3RELE1BQU0sRUFBRSx1QkFBdUI7WUFDL0IsY0FBYyxFQUFFLHNCQUFzQixDQUFDLGNBQWMsQ0FBQyxrQkFBa0I7WUFDeEUsWUFBWSxFQUFFO2dCQUNaLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDLEVBQUU7Z0JBQ3pCLEVBQUUsS0FBSyxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDLEVBQUU7YUFDMUI7WUFDRCxRQUFRLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDO1NBQ3BDLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXBQRCxzREFvUEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBhcHBsaWNhdGlvbmF1dG9zY2FsaW5nIGZyb20gJ0Bhd3MtY2RrL2F3cy1hcHBsaWNhdGlvbmF1dG9zY2FsaW5nJztcbmltcG9ydCAqIGFzIGNsb3Vkd2F0Y2ggZnJvbSAnQGF3cy1jZGsvYXdzLWNsb3Vkd2F0Y2gnO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ0Bhd3MtY2RrL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgZWNzIGZyb20gJ0Bhd3MtY2RrL2F3cy1lY3MnO1xuaW1wb3J0ICogYXMgZWxidjIgZnJvbSAnQGF3cy1jZGsvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ0Bhd3MtY2RrL2NvcmUnO1xuXG4vLyBDdXN0b21pemFibGUgY29uc3RydWN0IGlucHV0c1xuZXhwb3J0IGludGVyZmFjZSBJU2VsZW5pdW1HcmlkUHJvcHMge1xuICAvLyBWUENcbiAgcmVhZG9ubHkgdnBjPzogZWMyLklWcGM7XG5cbiAgLy8gU2VsZW5pdW0gdmVyc2lvbiB0byBwdWxsIGluLCBleDozLjE0MS41OVxuICByZWFkb25seSBzZWxlbml1bVZlcnNpb24/OiBzdHJpbmc7XG5cbiAgLy8gTWVtb3J5IHNldHRpbmdzIGZvciBodWIgYW5kIGNocm9tZSBmYXJnYXRlIG5vZGVzLCBleDogNTEyXG4gIHJlYWRvbmx5IG1lbW9yeT86IG51bWJlcjtcblxuICAvLyBDUFUgc2V0dGluZ3MgZm9yIGh1YiBhbmQgY2hyb21lIGZhcmdhdGUgbm9kZXMsIGV4OiAyNTZcbiAgcmVhZG9ubHkgY3B1PzogbnVtYmVyO1xuXG4gIC8vIFNlbGVuaXVtIE5PREVfTUFYX0lOU1RBTkNFUyBwb2ludGluZyB0byBudW1iZXIgb2YgaW5zdGFuY2VzIG9mIHNhbWUgdmVyc2lvbiBvZiBicm93c2VyIHRoYXQgY2FuIHJ1biBpbiBub2RlLCBleDogNVxuICByZWFkb25seSBzZWxlbml1bU5vZGVNYXhJbnN0YW5jZXM/OiBudW1iZXI7XG5cbiAgLy8gU2VsZW5pdW0gTk9ERV9NQVhfU0VTU0lPTiBwb2ludGluZyB0byBudW1iZXIgb2YgYnJvd3NlcnMgKEFueSBicm93c2VyIGFuZCB2ZXJzaW9uKSB0aGF0IGNhbiBydW4gaW4gcGFyYWxsZWwgYXQgYSB0aW1lIGluIG5vZGUsIGV4OiA1XG4gIHJlYWRvbmx5IHNlbGVuaXVtTm9kZU1heFNlc3Npb25zPzogbnVtYmVyO1xuXG4gIC8vIEF1dG8tc2NhbGUgbWluaW11bSBudW1iZXIgb2YgaW5zdGFuY2VzXG4gIHJlYWRvbmx5IG1pbkluc3RhbmNlcz86IG51bWJlcjtcblxuICAvLyBBdXRvLXNjYWxlIG1heGltdW0gbnVtYmVyIG9mIGluc3RhbmNlc1xuICByZWFkb25seSBtYXhJbnN0YW5jZXM/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSVJlc291cmNlRGVmaW5pdGlvblByb3Bze1xuICBjbHVzdGVyOiBlY3MuQ2x1c3RlcjtcbiAgc3RhY2s6IGNkay5Db25zdHJ1Y3Q7XG4gIGxvYWRCYWxhbmNlcjogZWxidjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXI7XG4gIHNlY3VyaXR5R3JvdXA6IGVjMi5TZWN1cml0eUdyb3VwO1xuICBpZGVudGlmaWVyOiBzdHJpbmc7XG4gIG1pbkluc3RhbmNlczogbnVtYmVyO1xuICBtYXhJbnN0YW5jZXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBJU2VydmljZURlZmluaXRpb25Qcm9wc3tcbiAgcmVzb3VyY2U6IElSZXNvdXJjZURlZmluaXRpb25Qcm9wcztcbiAgaW1hZ2U6IHN0cmluZztcbiAgZW52OiB7W2tleTogc3RyaW5nXTogc3RyaW5nfTtcbiAgcmVhZG9ubHkgZW50cnlQb2ludD86IHN0cmluZ1tdO1xuICByZWFkb25seSBjb21tYW5kPzogc3RyaW5nW107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSVNjYWxpbmdQb2xpY3lEZWZpbml0aW9uUHJvcHN7XG4gIHN0YWNrOiBjZGsuQ29uc3RydWN0O1xuICBzZXJ2aWNlTmFtZTogc3RyaW5nO1xuICBjbHVzdGVyTmFtZTogc3RyaW5nO1xuICBpZGVudGlmaWVyOiBzdHJpbmc7XG4gIG1pbkluc3RhbmNlczogbnVtYmVyO1xuICBtYXhJbnN0YW5jZXM6IG51bWJlcjtcbn1cblxuZXhwb3J0IGNsYXNzIFNlbGVuaXVtR3JpZENvbnN0cnVjdCBleHRlbmRzIGNkay5Db25zdHJ1Y3Qge1xuXG4gIHJlYWRvbmx5IHZwYzogZWMyLklWcGM7XG4gIHJlYWRvbmx5IHNlbGVuaXVtVmVyc2lvbjogc3RyaW5nO1xuICByZWFkb25seSBtZW1vcnk6IG51bWJlcjtcbiAgcmVhZG9ubHkgY3B1OiBudW1iZXI7XG4gIHJlYWRvbmx5IHNlbGVuaXVtTm9kZU1heEluc3RhbmNlczogbnVtYmVyO1xuICByZWFkb25seSBzZWxlbml1bU5vZGVNYXhTZXNzaW9uczogbnVtYmVyO1xuICByZWFkb25seSBtaW5JbnN0YW5jZXM6IG51bWJlcjtcbiAgcmVhZG9ubHkgbWF4SW5zdGFuY2VzOiBudW1iZXI7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5Db25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBJU2VsZW5pdW1HcmlkUHJvcHMgPSB7fSkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAvLyBDcmVhdGUgbmV3IFZQQyBpZiBpdCBkb2VzbnQgZXhpc3RcbiAgICB0aGlzLnZwYyA9IHByb3BzLnZwYyA/PyBuZXcgZWMyLlZwYyh0aGlzLCAnVnBjJywgeyBuYXRHYXRld2F5czogMSB9KTtcbiAgICB0aGlzLnNlbGVuaXVtVmVyc2lvbiA9IHByb3BzLnNlbGVuaXVtVmVyc2lvbiA/PyAnMy4xNDEuNTknO1xuICAgIHRoaXMubWVtb3J5ID0gcHJvcHMubWVtb3J5ID8/IDUxMjtcbiAgICB0aGlzLmNwdSA9IHByb3BzLmNwdSA/PyAyNTY7XG4gICAgdGhpcy5zZWxlbml1bU5vZGVNYXhJbnN0YW5jZXMgPSBwcm9wcy5zZWxlbml1bU5vZGVNYXhJbnN0YW5jZXMgPz8gNTtcbiAgICB0aGlzLnNlbGVuaXVtTm9kZU1heFNlc3Npb25zID0gcHJvcHMuc2VsZW5pdW1Ob2RlTWF4U2Vzc2lvbnMgPz8gNTtcbiAgICB0aGlzLm1pbkluc3RhbmNlcyA9IHByb3BzLm1pbkluc3RhbmNlcyA/PyAxO1xuICAgIHRoaXMubWF4SW5zdGFuY2VzID0gcHJvcHMubWF4SW5zdGFuY2VzID8/IDEwO1xuXG4gICAgLy8gQ2x1c3RlclxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ2NsdXN0ZXInLCB7XG4gICAgICB2cGM6IHRoaXMudnBjLFxuICAgICAgY29udGFpbmVySW5zaWdodHM6IHRydWVcbiAgICB9KTtcblxuICAgIC8vIFNldHVwIGNhcGFjaXR5IHByb3ZpZGVycyBhbmQgZGVmYXVsdCBzdHJhdGVneSBmb3IgY2x1c3RlclxuICAgIGNvbnN0IGNmbkVjc0NsdXN0ZXIgPSBjbHVzdGVyLm5vZGUuZGVmYXVsdENoaWxkIGFzIGVjcy5DZm5DbHVzdGVyO1xuICAgIGNmbkVjc0NsdXN0ZXIuY2FwYWNpdHlQcm92aWRlcnMgPSBbJ0ZBUkdBVEUnLCAnRkFSR0FURV9TUE9UJ107XG4gICAgY2ZuRWNzQ2x1c3Rlci5kZWZhdWx0Q2FwYWNpdHlQcm92aWRlclN0cmF0ZWd5ID0gW3tcbiAgICAgIGNhcGFjaXR5UHJvdmlkZXI6ICdGQVJHQVRFJyxcbiAgICAgIHdlaWdodDogMSxcbiAgICAgIGJhc2U6IDQsXG4gICAgfSwge1xuICAgICAgY2FwYWNpdHlQcm92aWRlcjogJ0ZBUkdBVEVfU1BPVCcsXG4gICAgICB3ZWlnaHQ6IDQsXG4gICAgfV07XG5cbiAgICAvLyBDcmVhdGUgc2VjdXJpdHkgZ3JvdXAgYW5kIGFkZCBpbmJvdW5kIGFuZCBvdXRib3VuZCB0cmFmZmljIHBvcnRzXG4gICAgdmFyIHNlY3VyaXR5R3JvdXAgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ3NlY3VyaXR5LWdyb3VwLXNlbGVuaXVtJywge1xuICAgICAgdnBjOiBjbHVzdGVyLnZwYyxcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IHRydWUsXG4gICAgfSk7XG5cbiAgICAvLyBPcGVuIHVwIHBvcnQgNDQ0NCBhbmQgNTU1NSBmb3IgZXhlY3V0aW9uXG4gICAgc2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5hbnlJcHY0KCksIGVjMi5Qb3J0LnRjcCg0NDQ0KSwgJ1BvcnQgNDQ0NCBmb3IgaW5ib3VuZCB0cmFmZmljJyk7XG4gICAgc2VjdXJpdHlHcm91cC5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5hbnlJcHY0KCksIGVjMi5Qb3J0LnRjcCg1NTU1KSwgJ1BvcnQgNTU1NSBmb3IgaW5ib3VuZCB0cmFmZmljJyk7XG5cbiAgICAvLyBTZXR1cCBMb2FkIGJhbGFuY2VyICYgcmVnaXN0ZXIgdGFyZ2V0c1xuICAgIHZhciBsb2FkQmFsYW5jZXIgPSBuZXcgZWxidjIuQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIodGhpcywgJ2FwcC1sYicsIHtcbiAgICAgIHZwYzogdGhpcy52cGMsXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcbiAgICB9KTtcbiAgICBsb2FkQmFsYW5jZXIuYWRkU2VjdXJpdHlHcm91cChzZWN1cml0eUdyb3VwKTtcblxuICAgIC8vIFJlZ2lzdGVyIFNlbGVuaXVtSHViIHJlc291cmNlc1xuICAgIHRoaXMuY3JlYXRlSHViUmVzb3VyY2VzKHtcbiAgICAgIGNsdXN0ZXI6IGNsdXN0ZXIsXG4gICAgICBpZGVudGlmaWVyOiAnaHViJyxcbiAgICAgIGxvYWRCYWxhbmNlcjogbG9hZEJhbGFuY2VyLFxuICAgICAgc2VjdXJpdHlHcm91cDogc2VjdXJpdHlHcm91cCxcbiAgICAgIHN0YWNrOiB0aGlzLFxuICAgICAgbWF4SW5zdGFuY2VzOiB0aGlzLm1heEluc3RhbmNlcyxcbiAgICAgIG1pbkluc3RhbmNlczogdGhpcy5taW5JbnN0YW5jZXMgICAgIFxuICAgIH0pO1xuXG4gICAgLy8gUmVnaXN0ZXIgQ2hyb21lIG5vZGUgcmVzb3VyY2VzXG4gICAgdGhpcy5jcmVhdGVCcm93c2VyUmVzb3VyY2Uoe1xuICAgICAgY2x1c3RlcjogY2x1c3RlcixcbiAgICAgIGlkZW50aWZpZXI6ICdjaHJvbWUnLFxuICAgICAgbG9hZEJhbGFuY2VyOiBsb2FkQmFsYW5jZXIsXG4gICAgICBzZWN1cml0eUdyb3VwOiBzZWN1cml0eUdyb3VwLFxuICAgICAgc3RhY2s6IHRoaXMsXG4gICAgICBtYXhJbnN0YW5jZXM6IHRoaXMubWF4SW5zdGFuY2VzLFxuICAgICAgbWluSW5zdGFuY2VzOiB0aGlzLm1pbkluc3RhbmNlc1xuICAgIH0sICdzZWxlbml1bS9ub2RlLWNocm9tZScpO1xuXG4gICAgLy8gUmVnaXN0ZXIgRmlyZWZveCBub2RlIHJlc291cmNlc1xuICAgIHRoaXMuY3JlYXRlQnJvd3NlclJlc291cmNlKHtcbiAgICAgIGNsdXN0ZXI6IGNsdXN0ZXIsXG4gICAgICBpZGVudGlmaWVyOiAnZmlyZWZveCcsXG4gICAgICBsb2FkQmFsYW5jZXI6IGxvYWRCYWxhbmNlcixcbiAgICAgIHNlY3VyaXR5R3JvdXA6IHNlY3VyaXR5R3JvdXAsXG4gICAgICBzdGFjazogdGhpcyxcbiAgICAgIG1heEluc3RhbmNlczogdGhpcy5tYXhJbnN0YW5jZXMsXG4gICAgICBtaW5JbnN0YW5jZXM6IHRoaXMubWluSW5zdGFuY2VzXG4gICAgfSwgJ3NlbGVuaXVtL25vZGUtZmlyZWZveCcpO1xuXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xvYWRCYWxhbmNlckROUycsIHtcbiAgICAgIGV4cG9ydE5hbWU6ICdTZWxlbml1bS1IdWItRE5TJyxcbiAgICAgIHZhbHVlOiBsb2FkQmFsYW5jZXIubG9hZEJhbGFuY2VyRG5zTmFtZSxcbiAgICB9KTtcbiAgfVxuXG4gIGNyZWF0ZUh1YlJlc291cmNlcyhvcHRpb25zOiBJUmVzb3VyY2VEZWZpbml0aW9uUHJvcHMpIHtcbiAgICB2YXIgc2VydmljZSA9IHRoaXMuY3JlYXRlU2VydmljZSh7XG4gICAgICByZXNvdXJjZTogb3B0aW9ucyxcbiAgICAgIGVudjoge1xuICAgICAgICBHUklEX0JST1dTRVJfVElNRU9VVDogJzIwMDAwMCcsXG4gICAgICAgIEdSSURfVElNRU9VVDogJzE4MCcsXG4gICAgICAgIFNFX09QVFM6ICctZGVidWcnLFxuICAgICAgfSxcbiAgICAgIGltYWdlOiAnc2VsZW5pdW0vaHViOicrdGhpcy5zZWxlbml1bVZlcnNpb24sXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgYXV0b3NjYWxpbmcgcG9saWN5XG4gICAgdGhpcy5jcmVhdGVTY2FsaW5nUG9saWN5KHtcbiAgICAgIGNsdXN0ZXJOYW1lOiBvcHRpb25zLmNsdXN0ZXIuY2x1c3Rlck5hbWUsXG4gICAgICBzZXJ2aWNlTmFtZTogc2VydmljZS5zZXJ2aWNlTmFtZSxcbiAgICAgIGlkZW50aWZpZXI6IG9wdGlvbnMuaWRlbnRpZmllcixcbiAgICAgIHN0YWNrOiBvcHRpb25zLnN0YWNrLFxuICAgICAgbWluSW5zdGFuY2VzOiBvcHRpb25zLm1pbkluc3RhbmNlcyxcbiAgICAgIG1heEluc3RhbmNlczogb3B0aW9ucy5tYXhJbnN0YW5jZXNcbiAgICB9KTtcblxuICAgIC8vIERlZmF1bHQgdGFyZ2V0IHJvdXRpbmcgZm9yIDQ0NDQgc28gd2ViZHJpdmVyIGNsaWVudCBjYW4gY29ubmVjdCB0b1xuICAgIGNvbnN0IGxpc3RlbmVyID0gb3B0aW9ucy5sb2FkQmFsYW5jZXIuYWRkTGlzdGVuZXIoJ0xpc3RlbmVyJywgeyBwb3J0OiA0NDQ0LCBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQIH0pO1xuICAgIHNlcnZpY2UucmVnaXN0ZXJMb2FkQmFsYW5jZXJUYXJnZXRzKHtcbiAgICAgIGNvbnRhaW5lck5hbWU6ICdzZWxlbml1bS1odWItY29udGFpbmVyJyxcbiAgICAgIGNvbnRhaW5lclBvcnQ6IDQ0NDQsXG4gICAgICBuZXdUYXJnZXRHcm91cElkOiAnRUNTJyxcbiAgICAgIHByb3RvY29sOiBlY3MuUHJvdG9jb2wuVENQLFxuICAgICAgbGlzdGVuZXI6IGVjcy5MaXN0ZW5lckNvbmZpZy5hcHBsaWNhdGlvbkxpc3RlbmVyKGxpc3RlbmVyLCB7XG4gICAgICAgIHByb3RvY29sOiBlbGJ2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXG4gICAgICAgIHBvcnQ6IDQ0NDQsXG4gICAgICAgIHRhcmdldHM6IFtzZXJ2aWNlXSxcbiAgICAgIH0pLFxuICAgIH0pO1xuICB9XG5cbiAgY3JlYXRlQnJvd3NlclJlc291cmNlKG9wdGlvbnM6IElSZXNvdXJjZURlZmluaXRpb25Qcm9wcywgaW1hZ2U6IHN0cmluZykge1xuXG4gICAgLy8gRW52IHBhcmFtZXRlcnMgY29uZmlndXJlZCB0byBjb25uZWN0IGJhY2sgdG8gc2VsZW5pdW0gaHViIHdoZW4gbmV3IG5vZGVzIGdldHMgYWRkZWRcbiAgICB2YXIgc2VydmljZSA9IHRoaXMuY3JlYXRlU2VydmljZSh7XG4gICAgICByZXNvdXJjZTogb3B0aW9ucyxcbiAgICAgIGVudjoge1xuICAgICAgICBIVUJfUE9SVF80NDQ0X1RDUF9BRERSOiBvcHRpb25zLmxvYWRCYWxhbmNlci5sb2FkQmFsYW5jZXJEbnNOYW1lLFxuICAgICAgICBIVUJfUE9SVF80NDQ0X1RDUF9QT1JUOiAnNDQ0NCcsXG4gICAgICAgIE5PREVfTUFYX0lOU1RBTkNFUzogdGhpcy5zZWxlbml1bU5vZGVNYXhJbnN0YW5jZXMudG9TdHJpbmcoKSxcbiAgICAgICAgTk9ERV9NQVhfU0VTU0lPTjogdGhpcy5zZWxlbml1bU5vZGVNYXhTZXNzaW9ucy50b1N0cmluZygpLFxuICAgICAgICBTRV9PUFRTOiAnLWRlYnVnJyxcbiAgICAgICAgc2htX3NpemU6ICc1MTInLFxuICAgICAgfSxcbiAgICAgIGltYWdlOiBpbWFnZSsnOicrdGhpcy5zZWxlbml1bVZlcnNpb24sXG4gICAgICBlbnRyeVBvaW50OiBbJ3NoJywgJy1jJ10sXG4gICAgICBjb21tYW5kOiBbXCJQUklWQVRFPSQoY3VybCAtcyBodHRwOi8vMTY5LjI1NC4xNzAuMi92Mi9tZXRhZGF0YSB8IGpxIC1yICcuQ29udGFpbmVyc1sxXS5OZXR3b3Jrc1swXS5JUHY0QWRkcmVzc2VzWzBdJykgOyBleHBvcnQgUkVNT1RFX0hPU1Q9XFxcImh0dHA6Ly8kUFJJVkFURTo1NTU1XFxcIiA7IC9vcHQvYmluL2VudHJ5X3BvaW50LnNoXCJdLFxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIGF1dG9zY2FsaW5nIHBvbGljeVxuICAgIHRoaXMuY3JlYXRlU2NhbGluZ1BvbGljeSh7XG4gICAgICBjbHVzdGVyTmFtZTogb3B0aW9ucy5jbHVzdGVyLmNsdXN0ZXJOYW1lLFxuICAgICAgc2VydmljZU5hbWU6IHNlcnZpY2Uuc2VydmljZU5hbWUsXG4gICAgICBpZGVudGlmaWVyOiBvcHRpb25zLmlkZW50aWZpZXIsXG4gICAgICBzdGFjazogb3B0aW9ucy5zdGFjayxcbiAgICAgIG1pbkluc3RhbmNlczogb3B0aW9ucy5taW5JbnN0YW5jZXMsXG4gICAgICBtYXhJbnN0YW5jZXM6IG9wdGlvbnMubWF4SW5zdGFuY2VzXG4gICAgfSk7XG4gIH1cblxuICBjcmVhdGVTZXJ2aWNlKG9wdGlvbnM6IElTZXJ2aWNlRGVmaW5pdGlvblByb3BzKTogZWNzLkZhcmdhdGVTZXJ2aWNlIHtcbiAgICBjb25zdCBzdGFjayA9IG9wdGlvbnMucmVzb3VyY2Uuc3RhY2s7XG4gICAgY29uc3QgaWRlbnRpaWZlciA9IG9wdGlvbnMucmVzb3VyY2UuaWRlbnRpZmllcjtcbiAgICBjb25zdCBjbHVzdGVyID0gb3B0aW9ucy5yZXNvdXJjZS5jbHVzdGVyO1xuICAgIGNvbnN0IHNlY3VyaXR5R3JvdXAgPSBvcHRpb25zLnJlc291cmNlLnNlY3VyaXR5R3JvdXA7XG5cbiAgICAvLyBUYXNrIGFuZCBjb250YWluZXIgZGVmaW5pdGlvblxuICAgIGNvbnN0IHRhc2tEZWZpbml0aW9uID0gbmV3IGVjcy5GYXJnYXRlVGFza0RlZmluaXRpb24oc3RhY2ssICdzZWxlbml1bS0nK2lkZW50aWlmZXIrJy10YXNrLWRlZicse1xuICAgICAgbWVtb3J5TGltaXRNaUI6IHRoaXMubWVtb3J5LFxuICAgICAgY3B1OiB0aGlzLmNwdVxuICAgIH0pO1xuICAgIGNvbnN0IGNvbnRhaW5lckRlZmluaXRpb24gPSB0YXNrRGVmaW5pdGlvbi5hZGRDb250YWluZXIoJ3NlbGVuaXVtLScraWRlbnRpaWZlcisnLWNvbnRhaW5lcicsIHtcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbVJlZ2lzdHJ5KG9wdGlvbnMuaW1hZ2UpLFxuICAgICAgbWVtb3J5TGltaXRNaUI6IHRoaXMubWVtb3J5LFxuICAgICAgY3B1OiB0aGlzLmNwdSxcbiAgICAgIGVudmlyb25tZW50OiBvcHRpb25zLmVudixcbiAgICAgIGVzc2VudGlhbDogdHJ1ZSxcbiAgICAgIGxvZ2dpbmc6IG5ldyBlY3MuQXdzTG9nRHJpdmVyKHtcbiAgICAgICAgc3RyZWFtUHJlZml4OiAnc2VsZW5pdW0tJytpZGVudGlpZmVyKyctbG9ncycsXG4gICAgICB9KSxcbiAgICAgIGVudHJ5UG9pbnQ6IG9wdGlvbnMuZW50cnlQb2ludCxcbiAgICAgIGNvbW1hbmQ6IG9wdGlvbnMuY29tbWFuZCxcbiAgICB9KTtcblxuICAgIC8vIFBvcnQgbWFwcGluZ1xuICAgIGNvbnRhaW5lckRlZmluaXRpb24uYWRkUG9ydE1hcHBpbmdzKHtcbiAgICAgIGNvbnRhaW5lclBvcnQ6IDQ0NDQsXG4gICAgICBob3N0UG9ydDogNDQ0NCxcbiAgICAgIHByb3RvY29sOiBlY3MuUHJvdG9jb2wuVENQLFxuICAgIH0pO1xuXG4gICAgLy8gU2V0dXAgRmFyZ2F0ZSBzZXJ2aWNlXG4gICAgcmV0dXJuIG5ldyBlY3MuRmFyZ2F0ZVNlcnZpY2Uoc3RhY2ssICdzZWxlbml1bS0nK2lkZW50aWlmZXIrJy1zZXJ2aWNlJywge1xuICAgICAgY2x1c3RlcjogY2x1c3RlcixcbiAgICAgIHRhc2tEZWZpbml0aW9uOiB0YXNrRGVmaW5pdGlvbixcbiAgICAgIG1pbkhlYWx0aHlQZXJjZW50OiA3NSxcbiAgICAgIG1heEhlYWx0aHlQZXJjZW50OiAxMDAsICAgICAgXG4gICAgICBzZWN1cml0eUdyb3VwczogW3NlY3VyaXR5R3JvdXBdLFxuICAgIH0pO1xuICB9XG5cbiAgY3JlYXRlU2NhbGluZ1BvbGljeShvcHRpb25zOiBJU2NhbGluZ1BvbGljeURlZmluaXRpb25Qcm9wcykge1xuICAgIGNvbnN0IHNlcnZpY2VOYW1lID0gb3B0aW9ucy5zZXJ2aWNlTmFtZTtcbiAgICBjb25zdCBjbHVzdGVyTmFtZSA9IG9wdGlvbnMuY2x1c3Rlck5hbWU7XG4gICAgY29uc3QgaWRlbnRpZmllciA9IG9wdGlvbnMuaWRlbnRpZmllcjtcbiAgICBjb25zdCBzdGFjayA9IG9wdGlvbnMuc3RhY2s7XG5cbiAgICAvLyBTY2FsaW5nIHNldCBvbiBFQ1Mgc2VydmljZSBsZXZlbFxuICAgIGNvbnN0IHRhcmdldCA9IG5ldyBhcHBsaWNhdGlvbmF1dG9zY2FsaW5nLlNjYWxhYmxlVGFyZ2V0KHN0YWNrLCAnc2VsZW5pdW0tc2NhbGFibGVUYXJnZXQtJytpZGVudGlmaWVyLCB7XG4gICAgICBzZXJ2aWNlTmFtZXNwYWNlOiBhcHBsaWNhdGlvbmF1dG9zY2FsaW5nLlNlcnZpY2VOYW1lc3BhY2UuRUNTLFxuICAgICAgbWF4Q2FwYWNpdHk6IG9wdGlvbnMubWF4SW5zdGFuY2VzLFxuICAgICAgbWluQ2FwYWNpdHk6IG9wdGlvbnMubWluSW5zdGFuY2VzLFxuICAgICAgcmVzb3VyY2VJZDogJ3NlcnZpY2UvJytjbHVzdGVyTmFtZSsnLycrc2VydmljZU5hbWUsXG4gICAgICBzY2FsYWJsZURpbWVuc2lvbjogJ2VjczpzZXJ2aWNlOkRlc2lyZWRDb3VudCcsICAgIFxuICAgIH0pO1xuXG4gICAgLy8gTWV0cmljcyB0byBsaXN0ZW5cbiAgICBjb25zdCB3b3JrZXJVdGlsaXphdGlvbk1ldHJpYyA9IG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICBuYW1lc3BhY2U6ICdBV1MvRUNTJyxcbiAgICAgIG1ldHJpY05hbWU6ICdDUFVVdGlsaXphdGlvbicsXG4gICAgICBzdGF0aXN0aWM6ICdtYXgnLFxuICAgICAgcGVyaW9kOiBjZGsuRHVyYXRpb24ubWludXRlcygxKSxcbiAgICAgIGRpbWVuc2lvbnM6IHtcbiAgICAgICAgQ2x1c3Rlck5hbWU6IGNsdXN0ZXJOYW1lLFxuICAgICAgICBTZXJ2aWNlTmFtZTogc2VydmljZU5hbWUsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gRGVmaW5lIFNjYWxpbmcgcG9saWNpZXMgKHNjYWxlLWluIGFuZCBzY2FsZS1vdXQpXG4gICAgLy8gUmVtb3ZlIG9uZSBpbnN0YW5jZSBpZiBDUFVVdGlsaXphdGlvbiBpcyBsZXNzIHRoYW4gMzAlLFxuICAgIC8vIEFkZCB0aHJlZSBpbnN0YW5jZSBpZiB0aGUgQ1BVVXRpbGl6YXRpb24gaXMgZ3JlYXRlciB0aGFuIDcwJSAgICBcbiAgICB0YXJnZXQuc2NhbGVPbk1ldHJpYygnc3RlcC1tZXRyaWMtc2NhbGluZy0nK2lkZW50aWZpZXIsIHtcbiAgICAgIG1ldHJpYzogd29ya2VyVXRpbGl6YXRpb25NZXRyaWMsICAgICAgICAgIFxuICAgICAgYWRqdXN0bWVudFR5cGU6IGFwcGxpY2F0aW9uYXV0b3NjYWxpbmcuQWRqdXN0bWVudFR5cGUuQ0hBTkdFX0lOX0NBUEFDSVRZLCAgICAgIFxuICAgICAgc2NhbGluZ1N0ZXBzOiBbXG4gICAgICAgIHsgdXBwZXI6IDMwLCBjaGFuZ2U6IC0xIH0sXG4gICAgICAgIHsgbG93ZXI6IDgwLCBjaGFuZ2U6ICszIH0sXG4gICAgICBdLCAgICBcbiAgICAgIGNvb2xkb3duOiBjZGsuRHVyYXRpb24uc2Vjb25kcygxODApLCAgICAgIFxuICAgIH0pOyBcbiAgfVxufSJdfQ==