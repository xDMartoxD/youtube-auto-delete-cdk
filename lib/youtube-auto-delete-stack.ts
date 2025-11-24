import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as elasticache from 'aws-cdk-lib/aws-elasticache'
import { prodEnv } from '../constants/prod-env'

export class YoutubeAutoDeleteStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props)

        // Usar la VPC por defecto (más barato, no crea recursos nuevos)
        const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
            isDefault: true,
        })

        // STEP 1: Adding DynamoDB table
        const dynamoTable = new dynamodb.Table(this, 'YoutubeAutoDeleteDb', {
            tableName: 'youtube-auto-delete-db',
            partitionKey: {
                name: 'PK',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'SK',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        })

        // Add GSI1: GSI1PK (HASH) + GSI1SK (RANGE)
        dynamoTable.addGlobalSecondaryIndex({
            indexName: 'GSI1',
            partitionKey: {
                name: 'GSI1PK',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'GSI1SK',
                type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        })

        // Add GSI2: GSI2PK (HASH) + GSI2SK (RANGE)
        dynamoTable.addGlobalSecondaryIndex({
            indexName: 'GSI2',
            partitionKey: {
                name: 'GSI2PK',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'GSI2SK',
                type: dynamodb.AttributeType.STRING,
            },
            projectionType: dynamodb.ProjectionType.ALL,
        })

        // STEP 2: Adding ElastiCache/Valkey
        // Create a security group for ElastiCache
        const cacheSecurityGroup = new ec2.SecurityGroup(
            this,
            'CacheSecurityGroup',
            {
                vpc,
                description: 'Security group for YouTube auto-delete cache',
                allowAllOutbound: true,
            }
        )

        // Allow inbound connections on Redis/Valkey port (6379)
        cacheSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(6379),
            'Allow Redis/Valkey connections from within VPC'
        )

        // Create serverless Valkey ElastiCache cache
        // ElastiCache Serverless requiere entre 2 y 3 subnets
        // La VPC por defecto tiene subnets privadas, usamos esas o públicas como fallback
        const availableSubnets =
            vpc.privateSubnets.length > 0
                ? vpc.privateSubnets
                : vpc.publicSubnets

        // Limitar a máximo 3 subnets (requisito de ElastiCache Serverless: 2-3 subnets)
        const elasticacheSubnets = availableSubnets.slice(0, 3)

        if (elasticacheSubnets.length < 2) {
            throw new Error(
                `ElastiCache Serverless requires at least 2 subnets, but only ${elasticacheSubnets.length} are available`
            )
        }

        const serverlessCache = new elasticache.CfnServerlessCache(
            this,
            'YoutubeAutoDeleteCache',
            {
                engine: 'valkey',
                serverlessCacheName: 'youtube-auto-delete-cache',
                description:
                    'Serverless Valkey cache for YouTube auto-delete functionality',
                cacheUsageLimits: {
                    dataStorage: {
                        maximum: 5,
                        unit: 'GB',
                    },
                    ecpuPerSecond: {
                        maximum: 5000,
                    },
                },
                majorEngineVersion: '8',
                securityGroupIds: [cacheSecurityGroup.securityGroupId],
                subnetIds: elasticacheSubnets.map((subnet) => subnet.subnetId),
            }
        )

        // Ensure security group is created before ElastiCache
        serverlessCache.node.addDependency(cacheSecurityGroup)

        // STEP 3: Adding ECS Cluster and Service
        const cluster = new ecs.Cluster(this, 'YoutubeAutoDeleteCluster', {
            vpc,
        })

        // IAM Role for the task (app permissions)
        const taskRole = new iam.Role(this, 'YoutubeAutoDeleteTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description:
                'IAM role for YouTube Auto Delete backend to access AWS services',
        })

        // CloudWatch Logs - permisos específicos solo para el log group de esta app
        const logGroup = new logs.LogGroup(this, 'YoutubeAutoDeleteLogGroup', {
            retention: logs.RetentionDays.ONE_WEEK,
        })
        logGroup.grantWrite(taskRole)

        // DynamoDB - permisos de lectura/escritura
        dynamoTable.grantReadWriteData(taskRole)

        // CloudWatch Metrics - para métricas personalizadas
        taskRole.addToPrincipalPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'cloudwatch:PutMetricData',
                    'cloudwatch:GetMetricStatistics',
                ],
                resources: ['*'],
                conditions: {
                    StringEquals: {
                        'cloudwatch:namespace': 'YoutubeAutoDelete',
                    },
                },
            })
        )

        // ExecutionRole: el que usa ECS para sacar token de ECR, logs, etc.
        const executionRole = new iam.Role(
            this,
            'YoutubeAutoDeleteExecutionRole',
            {
                assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            }
        )

        executionRole.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName(
                'service-role/AmazonECSTaskExecutionRolePolicy'
            )
        )

        // Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(
            this,
            'YoutubeAutoDeleteTaskDefinition',
            {
                cpu: 1024, // 1 vCPU
                memoryLimitMiB: 3072, // 3 GB
                taskRole,
                executionRole,
            }
        )

        // Container
        const container = taskDefinition.addContainer(
            'YoutubeAutoDeleteContainer',
            {
                image: ecs.ContainerImage.fromRegistry(
                    '954573579519.dkr.ecr.us-east-1.amazonaws.com/main:latest'
                ),
                logging: ecs.LogDriver.awsLogs({
                    logGroup,
                    streamPrefix: 'youtube-auto-delete',
                }),
                environment: (() => {
                    // Get environment variables from constants
                    const envVars: { [key: string]: string } = { ...prodEnv }

                    // Get Valkey endpoint and construct REDIS_URL
                    const valkeyEndpoint = serverlessCache.attrEndpointAddress
                    const valkeyPort =
                        serverlessCache.attrEndpointPort || '6379'
                    const redisUrl = `rediss://${valkeyEndpoint}:${valkeyPort}`
                    envVars['REDIS_URL'] = redisUrl
                    envVars['TABLE_NAME'] = dynamoTable.tableName

                    // Set AWS region (already in prodEnv, but ensure it's set)
                    envVars['AWS_REGION'] = this.region || 'us-east-1'

                    return envVars
                })(),
            }
        )

        container.addPortMappings({
            containerPort: 80,
        })

        // Security Group for ECS tasks
        const ecsSecurityGroup = new ec2.SecurityGroup(
            this,
            'YoutubeAutoDeleteEcsSecurityGroup',
            {
                vpc,
                description:
                    'Security group for Youtube auto delete ECS service',
                allowAllOutbound: true,
            }
        )

        // Allow ECS tasks to connect to ElastiCache
        cacheSecurityGroup.addIngressRule(
            ecsSecurityGroup,
            ec2.Port.tcp(6379),
            'Allow ECS tasks to connect to cache'
        )

        // Fargate Service (without Load Balancer)
        const fargateService = new ecs.FargateService(
            this,
            'YoutubeAutoDeleteService',
            {
                cluster,
                taskDefinition,
                desiredCount: 1,
                securityGroups: [ecsSecurityGroup],
                vpcSubnets: {
                    subnets: vpc.publicSubnets,
                },
                assignPublicIp: true,
            }
        )

        // Outputs
        new cdk.CfnOutput(this, 'DynamoTableName', {
            value: dynamoTable.tableName,
            description: 'DynamoDB Table Name',
        })

        new cdk.CfnOutput(this, 'ElastiCacheEndpoint', {
            value: serverlessCache.attrEndpointAddress,
            description: 'ElastiCache Serverless Endpoint',
        })

        new cdk.CfnOutput(this, 'EcsClusterName', {
            value: cluster.clusterName,
            description: 'ECS Cluster Name',
        })

        new cdk.CfnOutput(this, 'ServiceName', {
            value: fargateService.serviceName,
            description: 'ECS Service Name',
        })

        new cdk.CfnOutput(this, 'TaskRoleArn', {
            value: taskRole.roleArn,
            description: 'IAM Role ARN for the backend task',
        })
    }
}
