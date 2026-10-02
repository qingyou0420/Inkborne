import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  DEFAULT_GITHUB_REPO,
  githubLatestApiUrl,
  githubApiHeaders,
  githubAssetHeaders,
  isAllowedDownloadUrl,
  pickSetupAsset,
  parseGithubLatestRelease,
  setupFileNameFromUrl,
  githubCheckErrorMessage,
} = require("../lib/github-release.cjs") as {
  DEFAULT_GITHUB_REPO: string;
  githubLatestApiUrl: (repo?: string) => string;
  githubApiHeaders: (token?: string) => Record<string, string>;
  githubAssetHeaders: (token?: string) => Record<string, string>;
  isAllowedDownloadUrl: (url: string) => boolean;
  pickSetupAsset: (assets: unknown) => {
    name: string;
    version: string;
    downloadUrl: string;
    assetApiUrl: string;
  } | null;
  parseGithubLatestRelease: (json: unknown) => {
    version: string;
    downloadUrl: string;
    assetApiUrl: string;
    assetName: string;
    tagName: string;
  } | null;
  setupFileNameFromUrl: (url: string) => string | null;
  githubCheckErrorMessage: (err: unknown) => string;
};

describe("github latest release parsing", () => {
  it("defaults to the public Lightbound repo", () => {
    // PR-1：默认仓库改为 qingyou0420/Lightbound（旧地址会重定向）；显式传入的仓库仍生效
    expect(DEFAULT_GITHUB_REPO).toBe("qingyou0420/Lightbound");
    expect(githubLatestApiUrl()).toBe(
      "https://api.github.com/repos/qingyou0420/Lightbound/releases/latest"
    );
    expect(githubLatestApiUrl("qingyou0420/Inkborne")).toBe(
      "https://api.github.com/repos/qingyou0420/Inkborne/releases/latest"
    );
    expect(githubApiHeaders()["User-Agent"]).toBe("Lightbound");
    expect(githubAssetHeaders()["User-Agent"]).toBe("Lightbound");
  });

  it("picks Fantasy-Writer-Setup and ignores other assets", () => {
    const picked = pickSetupAsset([
      {
        name: "Fantasy-Writer-Setup-1.4.0.exe",
        browser_download_url:
          "https://github.com/qingyou0420/Inkborne/releases/download/v1.4.0/Fantasy-Writer-Setup-1.4.0.exe",
        url: "https://api.github.com/repos/qingyou0420/Inkborne/releases/assets/2",
      },
      {
        name: "latest.yml",
        browser_download_url:
          "https://github.com/qingyou0420/Inkborne/releases/download/v1.4.0/latest.yml",
      },
    ]);
    expect(picked?.name).toBe("Fantasy-Writer-Setup-1.4.0.exe");
    expect(picked?.version).toBe("1.4.0");
  });

  it("picks Inkborne-Setup and still accepts FantaWriter-Setup", () => {
    const picked = pickSetupAsset([
      {
        name: "Fantasy-Writer-Setup-1.4.0.exe",
        browser_download_url:
          "https://github.com/qingyou0420/Inkborne/releases/download/v1.4.0/Fantasy-Writer-Setup-1.4.0.exe",
        url: "https://api.github.com/repos/qingyou0420/Inkborne/releases/assets/2",
      },
      {
        name: "FantaWriter-Setup-2.6.1.exe",
        browser_download_url:
          "https://github.com/qingyou0420/Inkborne/releases/download/v2.6.1/FantaWriter-Setup-2.6.1.exe",
        url: "https://api.github.com/repos/qingyou0420/Inkborne/releases/assets/3",
      },
      {
        name: "Inkborne-Setup-2.6.1.exe",
        browser_download_url:
          "https://github.com/qingyou0420/Inkborne/releases/download/v2.6.1/Inkborne-Setup-2.6.1.exe",
        url: "https://api.github.com/repos/qingyou0420/Inkborne/releases/assets/4",
      },
    ]);
    expect(picked?.name).toBe("Inkborne-Setup-2.6.1.exe");
    expect(picked?.version).toBe("2.6.1");
  });

  it("prefers Lightbound-Setup over the three legacy names", () => {
    // PR-1：同版本四个前缀都能识别，Lightbound-Setup 优先
    const picked = pickSetupAsset([
      {
        name: "Fantasy-Writer-Setup-3.0.0.exe",
        browser_download_url:
          "https://github.com/qingyou0420/Lightbound/releases/download/v3.0.0/Fantasy-Writer-Setup-3.0.0.exe",
        url: "https://api.github.com/repos/qingyou0420/Lightbound/releases/assets/1",
      },
      {
        name: "FantaWriter-Setup-3.0.0.exe",
        browser_download_url:
          "https://github.com/qingyou0420/Lightbound/releases/download/v3.0.0/FantaWriter-Setup-3.0.0.exe",
        url: "https://api.github.com/repos/qingyou0420/Lightbound/releases/assets/2",
      },
      {
        name: "Inkborne-Setup-3.0.0.exe",
        browser_download_url:
          "https://github.com/qingyou0420/Lightbound/releases/download/v3.0.0/Inkborne-Setup-3.0.0.exe",
        url: "https://api.github.com/repos/qingyou0420/Lightbound/releases/assets/3",
      },
      {
        name: "Lightbound-Setup-3.0.0.exe",
        browser_download_url:
          "https://github.com/qingyou0420/Lightbound/releases/download/v3.0.0/Lightbound-Setup-3.0.0.exe",
        url: "https://api.github.com/repos/qingyou0420/Lightbound/releases/assets/4",
      },
    ]);
    expect(picked?.name).toBe("Lightbound-Setup-3.0.0.exe");
    expect(picked?.version).toBe("3.0.0");
  });

  it("returns null when latest has no recognized Setup.exe", () => {
    expect(
      parseGithubLatestRelease({
        tag_name: "v9.9.9",
        assets: [{ name: "notes.md", browser_download_url: "https://example.com/notes.md" }],
      })
    ).toBeNull();
    expect(parseGithubLatestRelease(null)).toBeNull();
    expect(pickSetupAsset("nope")).toBeNull();
  });

  it("extracts Setup filename from a GitHub download URL", () => {
    // PR-1：下载地址同样识别 Lightbound-Setup
    expect(
      setupFileNameFromUrl(
        "https://github.com/qingyou0420/Lightbound/releases/download/v2.6.1/Lightbound-Setup-2.6.1.exe"
      )
    ).toBe("Lightbound-Setup-2.6.1.exe");
    expect(
      setupFileNameFromUrl(
        "https://github.com/qingyou0420/Inkborne/releases/download/v2.6.1/Inkborne-Setup-2.6.1.exe"
      )
    ).toBe("Inkborne-Setup-2.6.1.exe");
    expect(
      setupFileNameFromUrl(
        "https://github.com/qingyou0420/Inkborne/releases/download/v1.4.1/FantaWriter-Setup-1.4.1.exe"
      )
    ).toBe("FantaWriter-Setup-1.4.1.exe");
    expect(
      setupFileNameFromUrl(
        "https://github.com/qingyou0420/Inkborne/releases/download/v1.4.0/Fantasy-Writer-Setup-1.4.0.exe"
      )
    ).toBe("Fantasy-Writer-Setup-1.4.0.exe");
    expect(
      setupFileNameFromUrl("https://github.com/qingyou0420/Inkborne/releases/download/v1.0.0/notes.md")
    ).toBeNull();
  });
});

describe("github download guards", () => {
  it("allows GitHub / objects hosts and rejects others", () => {
    expect(
      isAllowedDownloadUrl(
        "https://github.com/qingyou0420/Inkborne/releases/download/v1.0.0/Fantasy-Writer-Setup-1.0.0.exe"
      )
    ).toBe(true);
    expect(
      isAllowedDownloadUrl(
        "https://api.github.com/repos/qingyou0420/Inkborne/releases/assets/2"
      )
    ).toBe(true);
    expect(
      isAllowedDownloadUrl(
        "https://objects.githubusercontent.com/github-production-release-asset-2e65be/foo"
      )
    ).toBe(true);
    expect(isAllowedDownloadUrl("http://github.com/foo")).toBe(false);
    expect(isAllowedDownloadUrl("https://evil.example/Fantasy-Writer-Setup-1.0.0.exe")).toBe(
      false
    );
  });

  it("adds Authorization only when a token is present", () => {
    expect(githubApiHeaders("").Authorization).toBeUndefined();
    expect(githubApiHeaders("ghp_test").Authorization).toBe("Bearer ghp_test");
    expect(githubAssetHeaders("ghp_test").Accept).toBe("application/octet-stream");
  });

  it("maps HTTP errors to public-repo hints", () => {
    // PR-1：404 提示补上 Lightbound-Setup，仍说明本仓公开
    expect(githubCheckErrorMessage(new Error("HTTP 404"))).toMatch(/公开/);
    expect(githubCheckErrorMessage(new Error("HTTP 404"))).toMatch(/Lightbound-Setup/);
    // PR-1 复审：404 提示补全四个前缀
    expect(githubCheckErrorMessage(new Error("HTTP 404"))).toMatch(/Fantasy-Writer-Setup/);
    expect(githubCheckErrorMessage(new Error("HTTP 401"))).toMatch(/拒绝/);
  });
});
