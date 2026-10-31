import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as cloudfront_origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as iam from 'aws-cdk-lib/aws-iam'
import { join } from 'path'
import { writeFileSync, mkdirSync } from 'fs'
import { DOMAIN_NAME, HOSTED_ZONE_ID, WWW_DOMAIN_NAME } from '../constants/domain'

export class FrontendStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props)

        // Look up hosted zone
        const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
            this,
            'YoutubeAutoDeleteHostedZone',
            {
                hostedZoneId: HOSTED_ZONE_ID,
                zoneName: DOMAIN_NAME,
            }
        )

        // ACM Certificate for both domains (must be in us-east-1 for CloudFront)
        const certificate = new acm.Certificate(
            this,
            'YoutubeAutoDeleteCertificate',
            {
                domainName: DOMAIN_NAME,
                subjectAlternativeNames: [WWW_DOMAIN_NAME],
                validation: acm.CertificateValidation.fromDns(hostedZone),
            }
        )

        // S3 Bucket for static files (NOT configured as website - CloudFront serves via OAC)
        // Name is generated: CloudFront serves the site, so it needn't match the domain
        const websiteBucket = new s3.Bucket(this, 'YoutubeAutoDeleteBucket', {
            // NO website configuration - CloudFront handles routing via errorResponses
            publicReadAccess: false, // CloudFront will access via OAC
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: false,
        })

        // CloudFront Distribution
        const distribution = new cloudfront.Distribution(
            this,
            'YoutubeAutoDeleteDistribution',
            {
                defaultBehavior: {
                    origin: cloudfront_origins.S3BucketOrigin.withOriginAccessControl(
                        websiteBucket
                    ),
                    viewerProtocolPolicy:
                        cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowedMethods:
                        cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                    cachedMethods:
                        cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
                    compress: true,
                    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                },
                domainNames: [
                    DOMAIN_NAME,
                    WWW_DOMAIN_NAME,
                ],
                certificate: certificate,
                defaultRootObject: 'index.html',
                errorResponses: [
                    {
                        httpStatus: 404,
                        responseHttpStatus: 200,
                        responsePagePath: '/index.html',
                        ttl: cdk.Duration.seconds(300),
                    },
                    {
                        httpStatus: 403,
                        responseHttpStatus: 200,
                        responsePagePath: '/index.html',
                        ttl: cdk.Duration.seconds(300),
                    },
                ],
                priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US, Canada, Europe
            }
        )

        // Grant CloudFront OAC access to S3 bucket
        websiteBucket.addToResourcePolicy(
            new iam.PolicyStatement({
                actions: ['s3:GetObject'],
                resources: [websiteBucket.arnForObjects('*')],
                principals: [
                    new iam.ServicePrincipal('cloudfront.amazonaws.com'),
                ],
                conditions: {
                    StringEquals: {
                        'AWS:SourceArn': distribution.distributionArn,
                    },
                },
            })
        )

        // Create a version file to force updates on each deployment
        // This ensures CDK detects changes even if source files are identical
        const versionFile = join(
            __dirname,
            '../client/youtube-auto-delete/.version'
        )
        try {
            writeFileSync(versionFile, new Date().toISOString())
        } catch (error) {
            // If directory doesn't exist, create it
            const versionDir = join(__dirname, '../client/youtube-auto-delete')
            mkdirSync(versionDir, { recursive: true })
            writeFileSync(versionFile, new Date().toISOString())
        }

        // Deploy files from client/dist to S3
        new s3deploy.BucketDeployment(this, 'FrontendDeployment', {
            sources: [
                s3deploy.Source.asset(
                    join(__dirname, '../client/youtube-auto-delete')
                ),
            ],
            destinationBucket: websiteBucket,
            distribution,
            distributionPaths: ['/*'], // Invalidate all paths on deployment
            prune: true, // Remove files from bucket that are not in source
            retainOnDelete: false, // Delete files when stack is deleted
            memoryLimit: 1024, // Increase memory limit for large deployments
        })

        // Route53 A Record for root domain
        // Apex domain
        new route53.ARecord(this, 'FrontendRootRecord', {
            zone: hostedZone,
            // sin recordName => apex del hosted zone
            target: route53.RecordTarget.fromAlias(
                new route53_targets.CloudFrontTarget(distribution)
            ),
        })

        // www subdomain
        new route53.ARecord(this, 'FrontendWwwRecord', {
            zone: hostedZone,
            recordName: 'www', // solo el subdominio, no el dominio completo
            target: route53.RecordTarget.fromAlias(
                new route53_targets.CloudFrontTarget(distribution)
            ),
        })

        // Outputs
        new cdk.CfnOutput(this, 'FrontendBucketName', {
            value: websiteBucket.bucketName,
            description: 'S3 Bucket Name for Frontend',
        })

        new cdk.CfnOutput(this, 'FrontendDistributionId', {
            value: distribution.distributionId,
            description: 'CloudFront Distribution ID',
        })

        new cdk.CfnOutput(this, 'FrontendDomain', {
            value: `https://${DOMAIN_NAME}`,
            description: 'Frontend Domain',
        })

        new cdk.CfnOutput(this, 'FrontendWwwDomain', {
            value: `https://${WWW_DOMAIN_NAME}`,
            description: 'Frontend WWW Domain',
        })
    }
}
