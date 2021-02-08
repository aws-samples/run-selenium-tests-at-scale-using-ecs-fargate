const { AwsCdkConstructLibrary } = require('projen');

const project = new AwsCdkConstructLibrary({
  author: 'Hari Ohm Prasath',
  authorAddress: 'harrajag@amazon.com',
  cdkVersion: '1.73.0',
  name: 'scaled-testing-cdk',
  repositoryUrl: 'https://github.com/harrajag/scaled-testing-cdk.git',
  cdkDependencies: [
    '@aws-cdk/core',
    '@aws-cdk/aws-ec2',
    '@aws-cdk/aws-ecs',
    '@aws-cdk/aws-eks',
    '@aws-cdk/aws-iam',
    '@aws-cdk/aws-applicationautoscaling',
    '@aws-cdk/aws-cloudwatch',
    '@aws-cdk/aws-elasticloadbalancingv2',
  ],
});

project.synth();
