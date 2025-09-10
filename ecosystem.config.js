module.exports = {
  apps: [
    {
      name: "mca-scraper",
      script: "npm",
      args: "start",
      env: {
        DISPLAY: ":1"
      }
    }
  ]
}
