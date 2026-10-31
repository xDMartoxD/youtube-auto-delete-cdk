// Production Environment Variables
// Generated from kubernetes/configmap.yaml

// Secret values (GOOGLE_CLIENT_SECRET, JWT_SECRET) live in AWS Secrets Manager
// under this name as JSON keys and are injected into the container by ECS.
export const BACKEND_SECRET_NAME = 'youtube-auto-delete/backend'

export const prodEnv = {
    // App Configuration
    APP_ENV: 'production',
    LOG_LEVEL: 'INFO',
    PYTHONPATH: '/app',

    // DynamoDB Configuration
    // TABLE_NAME will be set dynamically from the DynamoDB table
    AWS_REGION: 'us-east-1',

    // DYNAMODB_ENDPOINT should be empty/None for production (uses AWS DynamoDB)
    // AWS credentials are handled via IAM Roles (taskRole) in ECS
    // AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY not needed with IAM Roles

    // Google OAuth Configuration
    GOOGLE_CLIENT_ID:
        '1045602413659-ns6cq27oi7ro1vj9pd9m8biq7q59j259.apps.googleusercontent.com',

    // CORS Configuration
    CORS_ORIGINS:
        'https://playlistsmaster.com,https://www.playlistsmaster.com',

    // Redis/ElastiCache Configuration
    // REDIS_URL will be set dynamically from the cache endpoint
    REDIS_USE_TLS: 'true',
    REDIS_SSL_CERT_REQS: 'required',

    // Rate Limiting Configuration
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_PER_MINUTE: '60',
    RATE_LIMIT_PER_HOUR: '1000',

    // Cache TTL Configuration (in seconds)
    CACHE_TTL_USER_PLAYLISTS: '1800',
    CACHE_TTL_PLAYLIST_VIDEOS: '1800',
    CACHE_TTL_PLAYLIST_VIDEOS_BY_DATE: '1800',
    CACHE_TTL_USER_PROFILE: '1800',
    CACHE_TTL_USER_SESSION: '600',
    CACHE_TTL_DEFAULT: '1800',
}
