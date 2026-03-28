import { defineConfig } from "vitepress";

const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = repoName ? `/${repoName}/` : "/";

export default defineConfig({
  title: "Kumofire Jobs",
  description: "Queue-based asynchronous jobs for Cloudflare Workers.",
  base,
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/" },
      { text: "API", link: "/apis/" },
      { text: "GitHub", link: "https://github.com/tsugumi-sys/kumofire-jobs" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Overview", link: "/overview" },
          { text: "Architecture", link: "/architecture" },
          { text: "Development", link: "/development" },
          { text: "Notes For AI Coding Agents", link: "/agents" },
        ],
      },
      {
        text: "API",
        items: [
          { text: "API Docs", link: "/apis/" },
          { text: "Cloudflare API Overview", link: "/apis/cloudflare" },
          { text: "Create API", link: "/apis/create" },
          { text: "Dispatch API", link: "/apis/dispatch" },
          { text: "Consume API", link: "/apis/consume" },
          { text: "Schedules API", link: "/apis/schedules" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/tsugumi-sys/kumofire-jobs" },
    ],
    footer: {
      message: "MIT Licensed",
      copyright: "Copyright tsugumi-sys",
    },
  },
});
