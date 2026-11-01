import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as elasticache from 'aws-cdk-lib/aws-elasticache'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { prodEnv, BACKEND_SECRET_NAME } from '../constants/prod-env'
import {
    API_DOMAIN_NAME,
    DOMAIN_NAME,
    HOSTED_ZONE_ID,
} from '../constants/domain'

export class PlaylistMasterStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props)

        // Usar la VPC por defecto (más barato, no crea recursos nuevos)
        const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
            isDefault: true,
        })

        // STEP 1: Adding DynamoDB table
        const dynamoTable = new dynamodb.Table(this, 'PlaylistMasterDb', {
            tableName: 'playlistmaster-prod',
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
                description: 'Security group for the PlaylistMaster cache',
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
            'PlaylistMasterCache',
            {
                engine: 'valkey',
                serverlessCacheName: 'playlistmaster-cache',
                description:
                    'Serverless Valkey cache for the PlaylistMaster API',
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
        const cluster = new ecs.Cluster(this, 'PlaylistMasterCluster', {
            vpc,
        })

        // IAM Role for the task (app permissions)
        const taskRole = new iam.Role(this, 'PlaylistMasterTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description:
                'IAM role for the PlaylistMaster backend to access AWS services',
        })

        // CloudWatch Logs - permisos específicos solo para el log group de esta app
        const logGroup = new logs.LogGroup(this, 'PlaylistMasterLogGroup', {
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
                        'cloudwatch:namespace': 'PlaylistMaster',
                    },
                },
            })
        )

        // ExecutionRole: el que usa ECS para sacar token de ECR, logs, etc.
        const executionRole = new iam.Role(
            this,
            'PlaylistMasterExecutionRole',
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
            'PlaylistMasterTaskDefinition',
            {
                cpu: 256, // 0.25 vCPU
                memoryLimitMiB: 512, // 0.5 GB
                taskRole,
                executionRole,
            }
        )

        // Secrets (created outside CDK so values never live in the repo)
        const backendSecret = secretsmanager.Secret.fromSecretNameV2(
            this,
            'PlaylistMasterBackendSecret',
            BACKEND_SECRET_NAME
        )

        // Container
        const container = taskDefinition.addContainer(
            'PlaylistMasterContainer',
            {
                image: ecs.ContainerImage.fromRegistry(
                    '954573579519.dkr.ecr.us-east-1.amazonaws.com/main:latest'
                ),
                logging: ecs.LogDriver.awsLogs({
                    logGroup,
                    streamPrefix: 'playlistmaster',
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
                // Injected at task start; CDK grants the execution role read access
                secrets: {
                    GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
                        backendSecret,
                        'GOOGLE_CLIENT_SECRET'
                    ),
                    JWT_SECRET: ecs.Secret.fromSecretsManager(
                        backendSecret,
                        'JWT_SECRET'
                    ),
                    SPOTIFY_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
                        backendSecret,
                        'SPOTIFY_CLIENT_SECRET'
                    ),
                },
            }
        )

        container.addPortMappings({
            containerPort: 80,
        })

        // Security Group for ECS tasks
        const ecsSecurityGroup = new ec2.SecurityGroup(
            this,
            'PlaylistMasterEcsSecurityGroup',
            {
                vpc,
                description:
                    'Security group for the PlaylistMaster ECS service',
                allowAllOutbound: true,
            }
        )

        // Allow ECS tasks to connect to ElastiCache
        cacheSecurityGroup.addIngressRule(
            ecsSecurityGroup,
            ec2.Port.tcp(6379),
            'Allow ECS tasks to connect to cache'
        )

        // STEP 4: Adding Application Load Balancer
        // Security Group for ALB
        const albSecurityGroup = new ec2.SecurityGroup(
            this,
            'PlaylistMasterAlbSecurityGroup',
            {
                vpc,
                description: 'Security group for Application Load Balancer',
                allowAllOutbound: true,
            }
        )

        // Allow HTTP from internet to ALB
        albSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(80),
            'Allow HTTP traffic from internet'
        )

        // Allow ALB to connect to ECS tasks
        ecsSecurityGroup.addIngressRule(
            albSecurityGroup,
            ec2.Port.tcp(80),
            'Allow ALB to connect to ECS tasks'
        )

        // Application Load Balancer
        const loadBalancer = new elbv2.ApplicationLoadBalancer(
            this,
            'PlaylistMasterAlb',
            {
                vpc,
                internetFacing: true,
                securityGroup: albSecurityGroup,
                vpcSubnets: {
                    subnets: vpc.publicSubnets,
                },
            }
        )

        // Target Group
        const targetGroup = new elbv2.ApplicationTargetGroup(
            this,
            'PlaylistMasterTargetGroup',
            {
                vpc,
                port: 80,
                protocol: elbv2.ApplicationProtocol.HTTP,
                targetType: elbv2.TargetType.IP,
                healthCheck: {
                    enabled: true,
                    path: '/v1/health/ready',
                    healthyHttpCodes: '200',
                    interval: cdk.Duration.seconds(30),
                    timeout: cdk.Duration.seconds(5),
                    healthyThresholdCount: 2,
                    unhealthyThresholdCount: 3,
                },
            }
        )

        // Look up hosted zone
        const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
            this,
            'PlaylistMasterHostedZone',
            {
                hostedZoneId: HOSTED_ZONE_ID,
                zoneName: DOMAIN_NAME,
            }
        )

        // ACM Certificate for the API subdomain
        const certificate = new acm.Certificate(
            this,
            'PlaylistMasterCertificate',
            {
                domainName: API_DOMAIN_NAME,
                validation: acm.CertificateValidation.fromDns(hostedZone),
            }
        )

        // HTTP Listener (redirects to HTTPS)
        loadBalancer.addListener('HttpListener', {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.redirect({
                protocol: 'HTTPS',
                port: '443',
                permanent: true,
            }),
        })

        // HTTPS Listener
        loadBalancer.addListener('HttpsListener', {
            port: 443,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            certificates: [certificate],
            defaultAction: elbv2.ListenerAction.forward([targetGroup]),
        })

        // Fargate Service (with Load Balancer)
        // Tasks en subnets públicas con IP pública
        const fargateService = new ecs.FargateService(
            this,
            'PlaylistMasterService',
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

        // Attach ECS service to target group
        fargateService.attachToApplicationTargetGroup(targetGroup)

        // Route53 A Record
        new route53.ARecord(this, 'PlaylistMasterApiRecord', {
            zone: hostedZone,
            recordName: API_DOMAIN_NAME,
            target: route53.RecordTarget.fromAlias(
                new route53_targets.LoadBalancerTarget(loadBalancer)
            ),
        })

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

        new cdk.CfnOutput(this, 'LoadBalancerDns', {
            value: loadBalancer.loadBalancerDnsName,
            description: 'Application Load Balancer DNS Name',
        })

        new cdk.CfnOutput(this, 'ApiUrl', {
            value: `https://${API_DOMAIN_NAME}`,
            description: 'API URL',
        })
    }
}
