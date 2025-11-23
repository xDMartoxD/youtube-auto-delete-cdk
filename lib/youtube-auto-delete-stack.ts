import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as elasticache from 'aws-cdk-lib/aws-elasticache'

export class YoutubeAutoDeleteStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props)

        // STEP 2: Adding VPC
        // Create a VPC with public and isolated private subnets
        const vpc = new ec2.Vpc(this, 'YoutubeAutoDeleteVpc', {
            maxAzs: 2,
            natGateways: 0, // No NAT Gateway to save costs
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'private',
                    subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
                },
            ],
        })

        // Outputs so we can reference the VPC in later steps
        new cdk.CfnOutput(this, 'VpcId', {
            value: vpc.vpcId,
            description: 'VPC ID',
        })

        new cdk.CfnOutput(this, 'PublicSubnets', {
            value: vpc.publicSubnets.map((subnet) => subnet.subnetId).join(','),
            description: 'Public subnet IDs (comma separated)',
        })

        new cdk.CfnOutput(this, 'PrivateSubnets', {
            value: vpc.privateSubnets
                .map((subnet) => subnet.subnetId)
                .join(','),
            description: 'Private isolated subnet IDs (comma separated)',
        })

        // STEP 3: Adding ElastiCache/Valkey
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
        const privateSubnets =
            vpc.privateSubnets.length > 0
                ? vpc.privateSubnets
                : vpc.publicSubnets

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
                subnetIds: privateSubnets.map((subnet) => subnet.subnetId),
            }
        )

        // Ensure VPC, security group, and all subnets are created before ElastiCache
        serverlessCache.node.addDependency(vpc)
        serverlessCache.node.addDependency(cacheSecurityGroup)
        privateSubnets.forEach((subnet) => {
            serverlessCache.node.addDependency(subnet)
        })

        new cdk.CfnOutput(this, 'ElastiCacheEndpoint', {
            value: serverlessCache.attrEndpointAddress,
            description: 'ElastiCache Serverless Endpoint',
        })

        // STEP 1: Adding DynamoDB table only
        // Table definition matches the Python code structure
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

        new cdk.CfnOutput(this, 'DynamoTableName', {
            value: dynamoTable.tableName,
            description: 'DynamoDB Table Name',
        })
    }
}
