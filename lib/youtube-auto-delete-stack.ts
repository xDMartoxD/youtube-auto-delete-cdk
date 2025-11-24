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

        const cluster = new ecs.Cluster(this, 'YoutubeAutoDeleteCluster', {
            vpc,
            // Container Insights can be enabled later via AWS Console or CLI if needed
        })

        // Role que usa el contenedor (app) - Backend IAM Role
        const taskRole = new iam.Role(this, 'YoutubeAutoDeleteTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description:
                'IAM role for YouTube Auto Delete backend to access AWS services',
        })

        // CloudWatch Logs - permisos específicos solo para el log group de esta app
        // Más seguro que CloudWatchLogsFullAccess
        const logGroup = new logs.LogGroup(this, 'YoutubeAutoDeleteLogGroup', {
            retention: logs.RetentionDays.ONE_WEEK,
        })
        logGroup.grantWrite(taskRole)

        // DynamoDB - permisos de lectura/escritura (graneados automáticamente)
        dynamoTable.grantReadWriteData(taskRole)

        // CloudWatch Metrics - para métricas personalizadas
        // PutMetricData no requiere recursos específicos, pero limitamos el namespace
        taskRole.addToPrincipalPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'cloudwatch:PutMetricData',
                    'cloudwatch:GetMetricStatistics',
                ],
                resources: ['*'], // PutMetricData requiere '*' pero puedes usar Condition para limitar namespace
                conditions: {
                    StringEquals: {
                        'cloudwatch:namespace': 'YoutubeAutoDelete',
                    },
                },
            })
        )

        // Nota: ElastiCache/Valkey NO requiere permisos IAM para conectarse
        // El acceso se controla mediante Security Groups (ya configurado arriba)
        // Solo necesitarías permisos IAM si quieres listar/describir caches desde la app,
        // lo cual generalmente no es necesario

        // S3 - Comentar/remover si no necesitas S3
        // Si lo necesitas, especifica buckets específicos:
        // taskRole.addToPrincipalPolicy(
        //     new iam.PolicyStatement({
        //         effect: iam.Effect.ALLOW,
        //         actions: ['s3:GetObject', 's3:PutObject'],
        //         resources: ['arn:aws:s3:::tu-bucket-especifico/*'],
        //     })
        // )

        // Secrets Manager - Comentar/remover si no necesitas Secrets Manager
        // Si lo necesitas, especifica secretos específicos:
        // taskRole.addToPrincipalPolicy(
        //     new iam.PolicyStatement({
        //         effect: iam.Effect.ALLOW,
        //         actions: ['secretsmanager:GetSecretValue'],
        //         resources: ['arn:aws:secretsmanager:us-east-1:954573579519:secret:tu-secreto-*'],
        //     })
        // )

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
        // Si tienes imágenes en ECR privado, esto ya incluye permisos de ECR.
        // Si quisieras algo extra de S3, podrías añadir más policies aquí.

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

        // LogGroup ya creado arriba, reutilizamos la referencia

        const container = taskDefinition.addContainer(
            'YoutubeAutoDeleteContainer',
            {
                // Ajusta esto a tu repo real de ECR
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
                // Permitir que el contenedor use privilegios si es necesario
                // privileged: false, // Por defecto es false, pero puedes cambiarlo si tu app lo requiere
            }
        )

        container.addPortMappings({
            containerPort: 8080, // ajusta al puerto de tu app
        })

        // SG para el servicio ECS
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

        // Ejemplo: permitir tráfico HTTP desde Internet (si tienes API pública)
        ecsSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(80),
            'Allow HTTP access to containers'
        )

        // Aquí es donde estaba el problema de red:
        const fargateService = new ecs.FargateService(
            this,
            'YoutubeAutoDeleteService',
            {
                cluster,
                taskDefinition,
                desiredCount: 1,
                securityGroups: [ecsSecurityGroup],
                vpcSubnets: {
                    subnets: vpc.publicSubnets, // Task en subredes PÚBLICAS
                },
                assignPublicIp: true,
            }
        )

        // Outputs
        new cdk.CfnOutput(this, 'TaskRoleArn', {
            value: taskRole.roleArn,
            description: 'IAM Role ARN for the backend task',
        })

        new cdk.CfnOutput(this, 'DynamoTableName', {
            value: dynamoTable.tableName,
            description: 'DynamoDB Table Name',
        })

        new cdk.CfnOutput(this, 'ElastiCacheEndpoint', {
            value: serverlessCache.attrEndpointAddress,
            description: 'ElastiCache Serverless Endpoint',
        })
    }
}
