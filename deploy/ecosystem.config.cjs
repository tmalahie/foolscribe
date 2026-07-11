// pm2 : pm2 start deploy/ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'foolscribe',
      cwd: __dirname + '/..',
      script: 'server/dist/index.js',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '512M',
    },
  ],
};
