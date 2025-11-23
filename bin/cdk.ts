#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core'
import { YoutubeAutoDeleteStack } from '../lib/youtube-auto-delete-stack'

const app = new cdk.App()
new YoutubeAutoDeleteStack(app, 'YoutubeAutoDeleteStack', {
    env: { account: '954573579519', region: 'us-east-1' },
})
