#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core'
import { YoutubeAutoDeleteStack } from '../lib/youtube-auto-delete-stack'
import { FrontendStack } from '../lib/frontend-stack'

const app = new cdk.App()

// Backend Stack
new YoutubeAutoDeleteStack(app, 'YoutubeAutoDeleteStack', {
    env: { account: '954573579519', region: 'us-east-1' },
})

// Frontend Stack
new FrontendStack(app, 'FrontendStack', {
    env: { account: '954573579519', region: 'us-east-1' },
})
