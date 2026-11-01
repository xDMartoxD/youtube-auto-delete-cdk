#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core'
import { PlaylistMasterStack } from '../lib/playlist-master-stack'
import { PlaylistMasterFrontendStack } from '../lib/frontend-stack'

const app = new cdk.App()

// Backend Stack
new PlaylistMasterStack(app, 'PlaylistMasterStack', {
    env: { account: '954573579519', region: 'us-east-1' },
})

// Frontend Stack
new PlaylistMasterFrontendStack(app, 'PlaylistMasterFrontendStack', {
    env: { account: '954573579519', region: 'us-east-1' },
})
