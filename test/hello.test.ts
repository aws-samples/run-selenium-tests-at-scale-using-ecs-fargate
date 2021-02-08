import * as cdk from '@aws-cdk/core';
import { SeleniumGridConstruct } from '../src/index';
import '@aws-cdk/assert/jest';

test('create app', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app);
  new SeleniumGridConstruct(stack, 'SeleniumHubCluster', {
    cpu: 256,
    memory: 512,
    seleniumNodeMaxInstances: 5,
    seleniumNodeMaxSessions: 5,
  });
  expect(stack).toHaveResource('AWS::ECS::Cluster');
  expect(stack).toHaveResource('AWS::ECS::TaskDefinition');
  expect(stack).toHaveResource('AWS::EC2::SecurityGroup');
  expect(stack).toHaveResource('AWS::ECS::Service');
  expect(stack).toHaveResource('AWS::ElasticLoadBalancingV2::LoadBalancer');
  expect(stack).toHaveResource('AWS::ElasticLoadBalancingV2::Listener');
  expect(stack).toHaveResource('AWS::ElasticLoadBalancingV2::TargetGroup');
});