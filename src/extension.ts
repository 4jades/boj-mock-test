// src/extension.ts
import * as vscode from "vscode";
import * as cheerio from "cheerio";
import { spawn } from "child_process";

type SolvedSearchResponse = {
  count: number;
  items: Array<{
    problemId: number;
    titleKo: string | null;
  }>;
};

type PickedProblem = {
  problemId: number;
  title: string;
};

type ProblemPagePayload = {
  problemId: number;
  title: string;
  url: string;
  descHtml: string;
  inputHtml: string;
  outputHtml: string;
  samples: Array<{ input: string; output: string }>;
};

type LanguageId = "py" | "js" | "kt" | "java" | "cpp" | "c";

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type LangSpec = {
  id: LanguageId;
  label: string;
  filename: string;
  revealMetaHeader: (problemId: number, title: string, revealMeta: boolean) => string;
  compile?: (srcPath: string, workDir: string) => { cmd: string; args: string[]; timeoutMs?: number; outPath?: string };
  run: (srcPath: string, workDir: string, compiledOutPath?: string) => { cmd: string; args: string[] };
};

const HAND_CODING_KEY = "bojMockTest.handCodingMode";

/**
 * Sidebar View (Activity Bar / Side Bar WebviewView)
 * - 손코딩 모드 ON/OFF 버튼 색상 변경: ON일 때 primary, OFF일 때 secondary 유지
 */
class BojMockTestViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "boj-mock-test.view";
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public postHandCodingState(enabled: boolean) {
    if (!this.view) return;
    try {
      this.view.webview.postMessage({ type: "handCodingState", enabled: !!enabled });
    } catch {
      // ignore
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    const webview = webviewView.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "startMock") {
        await vscode.commands.executeCommand("boj-mock-test.pick3");
        return;
      }

      if (msg.type === "toggleIDE") {
        await vscode.commands.executeCommand("boj-mock-test.toggleHandCoding");
        return;
      }

      if (msg.type === "ready") {
        const current = this.context.globalState.get<boolean>(HAND_CODING_KEY, false);
        this.postHandCodingState(!!current);
        return;
      }
    });
  }

  private getHtml(webview: vscode.Webview) {
    const nonce = String(Date.now());

    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { padding: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    .title { font-weight: 900; margin: 0 0 10px; }
    .section { margin-top: 16px; }
    .sectionTitle { font-weight: 900; opacity: 0.9; margin: 0 0 10px; }
    .btn {
      width: 100%;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 10px 12px;
      border-radius: 10px;
      font-weight: 900;
      cursor: pointer;
      margin-bottom: 10px;
    }
    .btn.secondary {
      background: transparent;
      color: var(--vscode-foreground);
      border-color: var(--vscode-panel-border);
    }
    .hint { opacity: 0.75; font-size: 12px; }
  </style>
</head>
<body>
  <div class="title">boj-mock-test</div>

  <div class="section">
    <div class="sectionTitle">모의 테스트</div>
    <button class="btn" id="startMock">모의테스트 시작</button>
  </div>

  <div class="section">
    <div class="sectionTitle">IDE 제어</div>
    <button class="btn secondary" id="toggleIDE">손코딩 모드 ON/OFF</button>
    <div class="hint" id="hcHint"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const toggleBtn = document.getElementById("toggleIDE");
    const hcHint = document.getElementById("hcHint");

    function applyHandCodingState(enabled) {
      toggleBtn.classList.toggle("secondary", !enabled);
      hcHint.textContent = enabled ? "손코딩 모드: ON" : "손코딩 모드: OFF";
    }

    document.getElementById("startMock").addEventListener("click", () => {
      vscode.postMessage({ type: "startMock" });
    });

    document.getElementById("toggleIDE").addEventListener("click", () => {
      vscode.postMessage({ type: "toggleIDE" });
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === "handCodingState") {
        applyHandCodingState(!!msg.enabled);
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickN<T>(arr: T[], n: number): T[] {
  return shuffle(arr).slice(0, n);
}

async function fetchCandidates(handle: string, minTier: string, maxTier: string): Promise<PickedProblem[]> {
  const query = `*${minTier}..${maxTier} s#5000.. -@${handle}`;
  const url = new URL("https://solved.ac/api/v3/search/problem");
  url.searchParams.set("query", query);
  url.searchParams.set("page", "1");

  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`solved.ac API error: ${res.status} ${res.statusText}`);

  const data = (await res.json()) as SolvedSearchResponse;
  return data.items.map((p) => ({
    problemId: p.problemId,
    title: (p.titleKo ?? "").trim() || `BOJ ${p.problemId}`,
  }));
}

function absolutizeUrls(html: string, base: string): string {
  const $ = cheerio.load(html);

  $("img").each((_, el) => {
    const src = $(el).attr("src");
    if (!src) return;
    try {
      $(el).attr("src", new URL(src, base).toString());
    } catch {
      return;
    }
  });

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const abs = new URL(href, base).toString();
      $(el).attr("href", abs);
      $(el).attr("target", "_blank");
      $(el).attr("rel", "noreferrer");
    } catch {
      return;
    }
  });

  return $.html();
}

async function fetchProblemPage(problemId: number): Promise<ProblemPagePayload> {
  const url = `https://www.acmicpc.net/problem/${problemId}`;

  const res = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://www.acmicpc.net/",
    },
  });

  if (!res.ok) throw new Error(`BOJ page fetch error: ${res.status} ${res.statusText}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  const titleNode = $("#problem_title");
  const descNode = $("#problem_description");
  const inputNode = $("#problem_input");
  const outputNode = $("#problem_output");

  if (titleNode.length === 0 || descNode.length === 0 || inputNode.length === 0 || outputNode.length === 0) {
    throw new Error("BOJ page parse failed (missing sections).");
  }

  const title = (titleNode.text() || `BOJ ${problemId}`).trim();

  const desc = descNode.html();
  const input = inputNode.html();
  const output = outputNode.html();

  if (!desc || !input || !output) throw new Error("BOJ problem sections not found.");

  const samples: Array<{ input: string; output: string }> = [];
  for (let i = 1; i <= 30; i++) {
    const sin = $(`#sample-input-${i}`).text();
    const sout = $(`#sample-output-${i}`).text();
    if (!sin && !sout) break;
    samples.push({ input: sin ?? "", output: sout ?? "" });
  }

  return {
    problemId,
    title,
    url,
    descHtml: absolutizeUrls(desc, url),
    inputHtml: absolutizeUrls(input, url),
    outputHtml: absolutizeUrls(output, url),
    samples,
  };
}

function safeFilename(s: string) {
  return s.replace(/[\\/:*?"<>|]/g, "_");
}

function randToken(len: number) {
  const s = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return s.slice(0, len);
}

function sessionIdNow() {
  const d = new Date();
  const y = String(d.getFullYear());
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const se = String(d.getSeconds()).padStart(2, "0");
  return `${y}${mo}${da}_${h}${mi}${se}_${randToken(6)}`;
}

function buildLangSpecs(): Record<LanguageId, LangSpec> {
  const py: LangSpec = {
    id: "py",
    label: "Python",
    filename: "main.py",
    revealMetaHeader: (problemId, title, revealMeta) => {
      if (!revealMeta) return `# BOJ Mock Test\n`;
      return `# BOJ ${problemId} - ${title}\n# https://www.acmicpc.net/problem/${problemId}\n`;
    },
    run: (srcPath) => ({ cmd: "python3", args: [srcPath] }),
  };

  const js: LangSpec = {
    id: "js",
    label: "JavaScript",
    filename: "main.js",
    revealMetaHeader: (problemId, title, revealMeta) => {
      if (!revealMeta) return `// BOJ Mock Test\n`;
      return `// BOJ ${problemId} - ${title}\n// https://www.acmicpc.net/problem/${problemId}\n`;
    },
    run: (srcPath) => ({ cmd: "node", args: [srcPath] }),
  };

  const kt: LangSpec = {
    id: "kt",
    label: "Kotlin",
    filename: "Main.kt",
    revealMetaHeader: (problemId, title, revealMeta) => {
      if (!revealMeta) return `// BOJ Mock Test\n`;
      return `// BOJ ${problemId} - ${title}\n// https://www.acmicpc.net/problem/${problemId}\n`;
    },
    compile: (srcPath, workDir) => {
      const outJar = `${workDir}/main.jar`;
      return {
        cmd: "kotlinc",
        args: [srcPath, "-include-runtime", "-d", outJar],
        timeoutMs: 12000,
        outPath: outJar,
      };
    },
    run: (_srcPath, _workDir, compiledOutPath) => {
      if (!compiledOutPath) return { cmd: "java", args: ["-jar", "main.jar"] };
      return { cmd: "java", args: ["-jar", compiledOutPath] };
    },
  };

  const java: LangSpec = {
    id: "java",
    label: "Java",
    filename: "Main.java",
    revealMetaHeader: (problemId, title, revealMeta) => {
      if (!revealMeta) return `// BOJ Mock Test\n`;
      return `// BOJ ${problemId} - ${title}\n// https://www.acmicpc.net/problem/${problemId}\n`;
    },
    compile: (srcPath, workDir) => {
      return {
        cmd: "javac",
        args: ["-encoding", "UTF-8", "-d", workDir, srcPath],
        timeoutMs: 12000,
      };
    },
    run: (_srcPath, workDir) => ({ cmd: "java", args: ["-cp", workDir, "Main"] }),
  };

  const cpp: LangSpec = {
    id: "cpp",
    label: "C++",
    filename: "main.cpp",
    revealMetaHeader: (problemId, title, revealMeta) => {
      if (!revealMeta) return `// BOJ Mock Test\n`;
      return `// BOJ ${problemId} - ${title}\n// https://www.acmicpc.net/problem/${problemId}\n`;
    },
    compile: (srcPath, workDir) => {
      const outPath = `${workDir}/a.out`;
      return {
        cmd: "g++",
        args: ["-std=c++17", "-O2", "-pipe", srcPath, "-o", outPath],
        timeoutMs: 12000,
        outPath,
      };
    },
    run: (_srcPath, _workDir, compiledOutPath) => {
      const p = compiledOutPath || "./a.out";
      return { cmd: p, args: [] };
    },
  };

  const c: LangSpec = {
    id: "c",
    label: "C",
    filename: "main.c",
    revealMetaHeader: (problemId, title, revealMeta) => {
      if (!revealMeta) return `// BOJ Mock Test\n`;
      return `// BOJ ${problemId} - ${title}\n// https://www.acmicpc.net/problem/${problemId}\n`;
    },
    compile: (srcPath, workDir) => {
      const outPath = `${workDir}/a.out`;
      return {
        cmd: "gcc",
        args: ["-std=c11", "-O2", "-pipe", srcPath, "-o", outPath],
        timeoutMs: 12000,
        outPath,
      };
    },
    run: (_srcPath, _workDir, compiledOutPath) => {
      const p = compiledOutPath || "./a.out";
      return { cmd: p, args: [] };
    },
  };

  return { py, js, kt, java, cpp, c };
}

function makeTemplate(problemId: number, title: string, revealMeta: boolean, lang: LangSpec): string {
  const header = lang.revealMetaHeader(problemId, title, revealMeta);

  if (lang.id === "py") {
    return `${header}
import sys
input = sys.stdin.readline

def main():
    pass

if __name__ == "__main__":
    main()
`;
  }

  if (lang.id === "js") {
    return `${header}
"use strict";

const fs = require("fs");
const input = fs.readFileSync(0, "utf8").trimEnd().split(/\\s+/);

function main() {
  // TODO
}

main();
`;
  }

  if (lang.id === "kt") {
    return `${header}
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.StringTokenizer

private class FastScanner {
    private val br = BufferedReader(InputStreamReader(System.\`in\`))
    private var st: StringTokenizer? = null

    fun next(): String {
        while (st == null || !st!!.hasMoreTokens()) {
            val line = br.readLine() ?: return ""
            st = StringTokenizer(line)
        }
        return st!!.nextToken()
    }
}

fun main() {
    // TODO
}
`;
  }

  if (lang.id === "java") {
    return `${header}
import java.io.*;
import java.util.*;

public class Main {

  public static void main(String[] args) throws Exception {
    // TODO
  }

}
`;
  }

  if (lang.id === "cpp") {
    return `${header}
#include <bits/stdc++.h>
using namespace std;

int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);

  // TODO
  return 0;
}
`;
  }

  return `${header}
#include <stdio.h>

int main(void) {
  // TODO
  return 0;
}
`;
}

async function runCmd(cmd: string, args: string[], stdin: string, timeoutMs: number, cwd?: string): Promise<RunResult> {
  return await new Promise<RunResult>((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd });

    let stdout = "";
    let stderr = "";
    let done = false;

    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        p.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve({ code, stdout, stderr, timedOut: false });
    });

    p.stdin.write(stdin ?? "");
    p.stdin.end();
  });
}

function normOut(s: string) {
  return (s ?? "").replace(/\r\n/g, "\n").trimEnd();
}

async function runProgram(lang: LangSpec, srcPath: string, workDir: string, stdin: string, timeoutMs: number) {
  let compiledOutPath: string | undefined;

  if (lang.compile) {
    const c = lang.compile(srcPath, workDir);
    const compileTimeout = c.timeoutMs ?? 12000;

    const cr = await runCmd(c.cmd, c.args, "", compileTimeout, workDir);
    if (cr.timedOut) return { code: null, stdout: "", stderr: `컴파일 시간 초과 (${compileTimeout}ms)\n${cr.stderr}`.trim(), timedOut: true };
    if (cr.code !== 0) return { code: cr.code, stdout: cr.stdout, stderr: `컴파일 에러\n${cr.stderr}`.trim(), timedOut: false };

    compiledOutPath = c.outPath;
  }

  const r = lang.run(srcPath, workDir, compiledOutPath);
  const rr = await runCmd(r.cmd, r.args, stdin, timeoutMs, workDir);
  return rr;
}

async function gradeOne(lang: LangSpec, srcPath: string, workDir: string, sample: { input: string; output: string }, timeoutMs: number) {
  const r = await runProgram(lang, srcPath, workDir, sample.input ?? "", timeoutMs);

  if (r.timedOut) return { ok: false, detail: `시간 초과 (${timeoutMs}ms)\n${(r.stderr ?? "").trim()}`.trim() };

  if (r.code !== 0) {
    const err = (r.stderr ?? "").trim();
    return { ok: false, detail: `런타임 에러\n${err}`.trim() };
  }

  const got = normOut(r.stdout);
  const exp = normOut(sample.output ?? "");

  if (got === exp) return { ok: true, detail: "" };

  return {
    ok: false,
    detail: `[기대]\n${exp}\n\n[출력]\n${got}`.trim(),
  };
}

async function runOnly(lang: LangSpec, srcPath: string, workDir: string, input: string, timeoutMs: number) {
  const r = await runProgram(lang, srcPath, workDir, input ?? "", timeoutMs);

  if (r.timedOut) return { ok: false, detail: `시간 초과 (${timeoutMs}ms)\n${(r.stderr ?? "").trim()}`.trim() };

  if (r.code !== 0) {
    const err = (r.stderr ?? "").trim();
    const out = normOut(r.stdout);
    return {
      ok: false,
      detail: `런타임 에러\n\n[stdout]\n${out}\n\n[stderr]\n${err}`.trim(),
    };
  }

  const out = normOut(r.stdout);
  const err = normOut(r.stderr);
  const tail = err ? `\n\n[stderr]\n${err}` : "";
  return { ok: true, detail: `[stdout]\n${out}${tail}`.trim() };
}

function fmt(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function esc(s: string) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function runResultRow(idx: number, ok: boolean, detail: string) {
  const badge = ok
    ? `<span class="badge ok"><span class="emoji">✅</span>PASS</span>`
    : `<span class="badge fail"><span class="emoji">❌</span>FAIL</span>`;

  let detailHtml = "";
  if (detail) {
    const d = (detail ?? "").replace(/\r\n/g, "\n").trimEnd();
    // "오답\n\n[기대]\n...\n\n[출력]\n..." 패턴이면 2컬럼으로 렌더
    const m = d.match(/^(?:\s*오답\s*\n\s*\n)?\[기대\]\n([\s\S]*?)\n\s*\n\[출력\]\n([\s\S]*)\s*$/);
    if (m) {
      const exp = esc(m[1] ?? "");
      const got = esc(m[2] ?? "");
      detailHtml = `
        <div class="grid2">
          <div>
            <div style="font-weight:900;margin-bottom:6px;">기대</div>
            <div class="card" style="padding:10px;">
              <pre class="mono" style="margin:0;">${exp}</pre>
            </div>
          </div>

          <div>
            <div style="font-weight:900;margin-bottom:6px;">출력</div>
            <div class="card" style="padding:10px;">
              <pre class="mono" style="margin:0;">${got}</pre>
            </div>
          </div>
        </div>
      `;
    } else {
      // 나머지(런타임 에러/시간초과 등)는 기존처럼 그대로
      detailHtml = `<pre class="mono">${esc(d)}</pre>`;
    }
  }

  return `
    <div class="resultRow" id="rr-${idx}">
      <div class="rowHead">
        <div class="mono"><b>예제 ${idx}</b></div>
        ${badge}
      </div>
      ${detailHtml}
    </div>
  `;
}


function runCustomRow(label: string, ok: boolean, detail: string) {
  const badge = ok
    ? `<span class="badge ok"><span class="emoji">⭕</span>PASS</span>`
    : `<span class="badge fail"><span class="emoji">❌</span>FAIL</span>`;

  const detailHtml = detail ? `<pre class="mono">${esc(detail)}</pre>` : "";
  return `
    <div class="resultRow">
      <div class="rowHead">
        <div class="mono"><b>${esc(label)}</b></div>
        ${badge}
      </div>
      ${detailHtml}
    </div>
  `;
}

function getWebviewHtml(webview: vscode.Webview) {
  const nonce = String(Date.now());

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="Content-Security-Policy"
    content="
      default-src 'none';
      img-src https: data: ${webview.cspSource};
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      font-src ${webview.cspSource};
    " />
  <title>BOJ Mock Test</title>
  <style>
    body { margin: 0; padding: 0; }

    .wrap {
      display: grid;
      grid-template-columns: 110px 1fr;
      height: 100vh;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
    }

    .left {
      border-right: 1px solid var(--vscode-panel-border);
      padding: 12px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .right {
      padding: 16px 18px;
      overflow: auto;
    }

    .h1 { font-size: 14px; font-weight: 900; margin: 0 0 8px; }

    .item {
      padding: 10px 10px;
      border-radius: 12px;
      cursor: pointer;
      border: 1px solid transparent;
      margin-bottom: 8px;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-list-hoverBackground));
      user-select: none;
    }
    .item:hover { border-color: var(--vscode-focusBorder); }
    .item.active { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); }

    .pid { font-weight: 900; font-size: 13px; }

    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      margin: 0 0 12px;
      flex-wrap: wrap;
    }

    .btn {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 10px;
      border-radius: 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 800;
    }
    .btn.secondary {
      background: transparent;
      border-color: var(--vscode-panel-border);
      color: var(--vscode-editor-foreground);
    }
    .btn:disabled { opacity: 0.5; cursor: default; }

    .iconBtn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      border: 1px solid var(--vscode-panel-border);
      background: transparent;
      color: var(--vscode-editor-foreground);
      cursor: pointer;
      font-weight: 900;
      font-size: 11px;
    }
    .iconBtn:hover { border-color: var(--vscode-focusBorder); }
    .iconBtn:disabled { opacity: 0.5; cursor: default; }

    /* 실행(▶)은 초록 */
    .runBtn {
      color: #2ea043;
      border-color: color-mix(in srgb, #2ea043 55%, var(--vscode-panel-border));
      background: color-mix(in srgb, #2ea043 10%, transparent);
    }
    .runBtn:hover {
      border-color: color-mix(in srgb, #2ea043 75%, var(--vscode-focusBorder));
      background: color-mix(in srgb, #2ea043 16%, transparent);
    }

    .section { margin-top: 18px; }
    .section h2 {
      font-size: 13px;
      margin: 0 0 10px;
      color: #4da3ff;
      font-weight: 900;
      letter-spacing: 0.2px;
    }

    .card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      padding: 14px;
      background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-editorWidget-background));
      line-height: 1.8;
      color: color-mix(in srgb, var(--vscode-editor-foreground) 88%, white);
    }

    pre {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      padding: 10px;
      overflow: auto;
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editorWidget-background));
      margin: 8px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .muted { opacity: 0.75; }
    a { color: var(--vscode-textLink-foreground); }
    img { max-width: 100%; height: auto; }

    .timerBox {
      margin-top: auto;
      padding: 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editorWidget-background));
    }
    .timerTitle { font-weight: 900; margin-bottom: 6px; color: #4da3ff; }
    .timerValue { font-family: var(--vscode-editor-font-family); font-size: 13px; font-weight: 900; }

    .finishTxt {
      display: inline-block;
      line-height: 1.15;
      text-align: center;
      white-space: normal;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-weight: 900;
      font-size: 12px;
      border: 1px solid var(--vscode-panel-border);
    }
    .badge.ok {
      background: color-mix(in srgb, #2ea043 18%, var(--vscode-editor-background));
      color: #e6ffed;
      border-color: color-mix(in srgb, #2ea043 60%, var(--vscode-panel-border));
    }
    .badge.fail {
      background: color-mix(in srgb, #f85149 18%, var(--vscode-editor-background));
      color: #ffecec;
      border-color: color-mix(in srgb, #f85149 60%, var(--vscode-panel-border));
    }
    .emoji { font-size: 13px; }

    .mono { font-family: var(--vscode-editor-font-family); }
    .small { font-size: 12px; opacity: 0.9; }

    .resultRow { margin-bottom: 14px; }
    .rowHead { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }

    .sampleHead {
      display: inline-flex;
      align-items: center;
      justify-content: flex-start;
      gap: 12px; /* 예제 텍스트에 붙게 */
      margin: 0 0 10px;
    }

    textarea {
      width: 100%;
      min-height: 90px;
      border-radius: 12px;
      border: 1px solid var(--vscode-panel-border);
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editorWidget-background));
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-editor-font-family);
      padding: 10px;
      resize: vertical;
      box-sizing: border-box;
    }

    .grid2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .tcItem {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      padding: 10px;
      background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-editorWidget-background));
      margin-top: 10px;
    }

    .tcTop {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }

    .tcLabel { font-weight: 900; }
    .tcBtns { display:flex; gap:8px; align-items:center; }

    /* 실행 결과로 스크롤 여백 */
    #runSection { scroll-margin-top: 14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="left">
      <div class="h1">문제 목록</div>
      <div id="list" class="muted">불러오는 중...</div>

      <div class="timerBox">
        <div class="timerTitle">남은 시간</div>
        <div id="timer" class="timerValue">--:--:--</div>

        <button id="finishBtn" class="btn" style="width:100%;margin-top:10px;">
          <span class="finishTxt">시험<br/>종료</span>
        </button>
      </div>
    </div>

    <div class="right">
      <div class="toolbar">
      </div>

      <div id="content" class="muted">불러오는 중...</div>

      <div class="section" id="runSection">
        <h2>실행 결과</h2>
        <div id="runHost" class="card muted">아직 실행하지 않았습니다.</div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    let problems = [];
    let activeId = null;
    let hideMeta = false;
    let examFinished = false;

    // { id, input, output }
    let customCases = [];

    const listEl = document.getElementById("list");
    const contentEl = document.getElementById("content");

    const runHost = document.getElementById("runHost");
    const timerEl = document.getElementById("timer");
    const finishBtn = document.getElementById("finishBtn");

    function escapeHtml(s) {
      return (s || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function shortText(s, maxLen) {
      const t = (s || "").trim();
      if (t.length <= maxLen) return t;
      return t.slice(0, maxLen) + "...";
    }

    function genId() {
      return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }

    function scrollToRunResult(target) {
      const el =
        target === "ex1"
          ? document.getElementById("ex-1")
          : document.getElementById("runSection");
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    finishBtn.addEventListener("click", () => {
      if (examFinished) return;
      vscode.postMessage({ type: "finishExam" });
    });

    function renderList() {
      if (!problems.length) {
        listEl.textContent = "문제가 없습니다.";
        listEl.classList.add("muted");
        return;
      }
      listEl.classList.remove("muted");
      listEl.innerHTML = "";

      problems.forEach((p, i) => {
        const div = document.createElement("div");
        div.className = "item" + (p.problemId === activeId ? " active" : "");
        div.dataset.pid = String(p.problemId);

        const pid = document.createElement("div");
        pid.className = "pid";
        pid.textContent = String(i + 1);

        div.appendChild(pid);

        div.addEventListener("click", () => {
          if (examFinished) return;

          const id = Number(div.dataset.pid);
          if (!id) return;

          activeId = id;

          runHost.innerHTML = '<div class="muted">아직 실행하지 않았습니다.</div>';

          renderList();
          contentEl.innerHTML = '<div class="muted">불러오는 중...</div>';

          vscode.postMessage({ type: "selectProblem", problemId: id });
        });

        listEl.appendChild(div);
      });
    }

    function attachExampleRunHandlers(sampleCount) {
      // 전체(샘플 + 추가) Run
      const allBtn = document.getElementById("runAllInline");
      if (allBtn) {
        allBtn.addEventListener("click", () => {
          if (!activeId) return;
          if (examFinished) return;
          vscode.postMessage({ type: "runAll", problemId: activeId, cases: customCases });
        });
      }

      // 개별 예제 Run (샘플/커스텀 공통)
      contentEl.addEventListener("click", (ev) => {
        const t = ev.target;
        if (!t) return;

        const btn = t.closest && t.closest("button[data-run='example']");
        if (!btn) return;

        if (!activeId) return;
        if (examFinished) return;

        const kind = String(btn.dataset.kind || "sample"); // sample | custom
        const idx = Number(btn.dataset.idx || "0"); // sample idx or custom idx
        if (Number.isNaN(idx)) return;

        if (kind === "sample") {
          vscode.postMessage({ type: "runOneSample", problemId: activeId, idx });
          return;
        }

        if (kind === "custom") {
          const c = customCases[idx];
          if (!c) return;
          const exampleNo = sampleCount + idx + 1;
          vscode.postMessage({
            type: "runOneCustom",
            problemId: activeId,
            exampleNo,
            input: c.input || "",
            expected: c.output || "",
          });
        }
      });
    }

    function renderProblem(payload) {
      activeId = payload.problemId;

      const samples = payload.samples || [];
      const sampleCount = samples.length;

      const headHtml = hideMeta
        ? \`
          <div style="font-size:16px;font-weight:900;margin:0 0 8px;">제목</div>
          <div class="muted" style="margin-bottom:16px;">비공개</div>
        \`
        : \`
          <div style="font-size:16px;font-weight:900;margin:0 0 8px;">\${escapeHtml(payload.title)}</div>
          <div class="muted" style="margin-bottom:16px;">BOJ \${payload.problemId}</div>
        \`;

      const samplesTop = (samples.length || customCases.length)
        ? \`
          <div class="section">
            <div class="sampleHead">
              <h2 style="margin:0;">전체 실행</h2>
              <button class="iconBtn runBtn" id="runAllInline" \${examFinished ? "disabled" : ""} title="전체 Run">▶</button>
            </div>
          </div>
        \`
        : "";

      const samplesHtml = (samples || []).map((s, idx) => {
        const i = escapeHtml(s.input || "");
        const o = escapeHtml(s.output || "");
        const no = idx + 1;
        return \`
          <div class="section" id="ex-\${no}">
            <div class="sampleHead">
              <h2 style="margin:0;">예제 \${no}</h2>
              <button class="iconBtn runBtn" data-run="example" data-kind="sample" data-idx="\${idx}" \${examFinished ? "disabled" : ""} title="예제 Run">▶</button>
            </div>
            <div class="card">
              <div class="grid2">
                <div>
                  <div style="font-weight:900;margin-bottom:6px;">입력</div>
                  <pre>\${i}</pre>
                </div>
                <div>
                  <div style="font-weight:900;margin-bottom:6px;">출력</div>
                  <pre>\${o}</pre>
                </div>
              </div>
            </div>
          </div>
        \`;
      }).join("");

      const customHtml = (customCases || []).map((c, idx) => {
        const no = sampleCount + idx + 1;
        const i = escapeHtml(c.input || "");
        const hasOut = (c.output || "").trim().length > 0;
        const o = escapeHtml(c.output || "");

        const outBlock = hasOut
          ? \`<pre>\${o}</pre>\`
          : \`<pre class="muted">(출력 미입력)</pre>\`;

        return \`
          <div class="section" id="ex-\${no}">
            <div class="sampleHead">
              <h2 style="margin:0;">예제 \${no}</h2>
              <button class="iconBtn runBtn" data-run="example" data-kind="custom" data-idx="\${idx}" \${examFinished ? "disabled" : ""} title="예제 Run">▶</button>
              <button class="btn secondary" data-del="custom" data-idx="\${idx}" \${examFinished ? "disabled" : ""} style="margin-left:8px;">삭제</button>
            </div>
            <div class="card">
              <div class="grid2">
                <div>
                  <div style="font-weight:900;margin-bottom:6px;">입력</div>
                  <pre>\${i}</pre>
                </div>
                <div>
                  <div style="font-weight:900;margin-bottom:6px;">출력</div>
                  \${outBlock}
                </div>
              </div>
            </div>
          </div>
        \`;
      }).join("");

      const addBox = \`
        <div class="section">
          <div class="card">
            <div style="font-weight:900;margin-bottom:10px;color:#4da3ff;">예제 추가</div>
            <div class="grid2">
              <div>
                <div style="font-weight:900;margin-bottom:6px;">입력</div>
                <textarea id="tcInput" placeholder="입력을 붙여넣어주세요" \${examFinished ? "disabled" : ""}></textarea>
              </div>
              <div>
                <div style="font-weight:900;margin-bottom:6px;">출력 (선택)</div>
                <textarea id="tcOutput" placeholder="기대 출력을 입력하면 PASS/FAIL로 채점합니다" \${examFinished ? "disabled" : ""}></textarea>
              </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
              <button id="addTcBtn" class="btn" \${examFinished ? "disabled" : ""}>추가</button>
            </div>
          </div>
        </div>
      \`;

      contentEl.innerHTML = \`
        \${headHtml}

        <div class="section">
          <h2>문제</h2>
          <div class="card">\${payload.descHtml}</div>
        </div>

        <div class="section">
          <h2>입력</h2>
          <div class="card">\${payload.inputHtml}</div>
        </div>

        <div class="section">
          <h2>출력</h2>
          <div class="card">\${payload.outputHtml}</div>
        </div>

        \${samplesTop}
        \${samplesHtml}
        \${customHtml}
        \${addBox}
      \`;

      // 삭제/추가 핸들러
      const addBtn = document.getElementById("addTcBtn");
      if (addBtn) {
        addBtn.addEventListener("click", () => {
          if (!activeId) return;
          if (examFinished) return;

          const inpEl = document.getElementById("tcInput");
          const outEl = document.getElementById("tcOutput");
          const inp = (inpEl && inpEl.value) ? inpEl.value : "";
          const out = (outEl && outEl.value) ? outEl.value : "";

          if (!inp.trim()) return;

          customCases.push({ id: genId(), input: inp, output: out });
          if (inpEl) inpEl.value = "";
          if (outEl) outEl.value = "";
          renderProblem(payload);
        });
      }

      contentEl.addEventListener("click", (ev) => {
        const t = ev.target;
        if (!t) return;

        const del = t.closest && t.closest("button[data-del='custom']");
        if (!del) return;
        if (examFinished) return;

        const idx = Number(del.dataset.idx || "0");
        if (Number.isNaN(idx)) return;

        customCases.splice(idx, 1);
        renderProblem(payload);
      });

      attachExampleRunHandlers(sampleCount);
      renderList();
    }

    function renderFinish(links) {
      examFinished = true;
      const runSection = document.getElementById("runSection");
      if (runSection) runSection.style.display = "none";
      const rows = (links || []).map((x) => {
        const label = escapeHtml(x.label || "문제");
        const submitUrl = escapeHtml(x.submitUrl || "");
        const statusUrl = escapeHtml(x.statusUrl || "");
        const problemUrl = escapeHtml(x.problemUrl || "");
        return \`
          <div class="resultRow">
            <div class="rowHead">
              <div class="mono"><b>\${label}</b></div>
              <span class="badge ok"><span class="emoji">✅</span>종료</span>
            </div>
            <div class="card">
              <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <a href="\${submitUrl}" target="_blank" rel="noreferrer">제출하기</a>
                <a href="\${statusUrl}" target="_blank" rel="noreferrer">채점/결과 확인</a>
                <a href="\${problemUrl}" target="_blank" rel="noreferrer">문제 보기</a>
              </div>
            </div>
          </div>
        \`;
      }).join("");

      contentEl.innerHTML = \`
        <div style="font-size:16px;font-weight:900;margin:0 0 8px;">시험 종료</div>
        <div class="muted" style="margin-bottom:16px;">아래 링크로 각 문제를 제출하고 결과를 확인할 수 있습니다.</div>
        \${rows || '<div class="muted">링크가 없습니다.</div>'}
      \`;
    }

    window.addEventListener("message", (event) => {
      const msg = event.data;

      if (msg.type === "init") {
        problems = msg.problems || [];
        hideMeta = !!msg.hideMeta;
        activeId = msg.activeProblemId || (problems[0] ? problems[0].problemId : null);
        renderList();
        return;
      }

      if (msg.type === "problemContent") {
        renderProblem(msg.payload);
        return;
      }

      if (msg.type === "timer") {
        timerEl.textContent = msg.text || "--:--:--";
        return;
      }

      if (msg.type === "runOutput") {
        runHost.innerHTML = msg.html || "";

        // 전체 실행이면 "예제 1 결과"로 스크롤
        if (msg.mode === "all") {
          const el = document.getElementById("rr-1");
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          scrollToRunResult(); // 기존: 실행 결과 섹션으로
        }
        return;
      }

      if (msg.type === "examFinished") {
        renderFinish(msg.links || []);
        return;
      }

      if (msg.type === "error") {
        contentEl.innerHTML = '<div class="muted">' + escapeHtml(msg.message || "오류") + "</div>";
        return;
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}

async function applyHandCodingMode(enabled: boolean) {
  const target = vscode.ConfigurationTarget.Global;

  const editorCfg = vscode.workspace.getConfiguration("editor");
  const tsCfg = vscode.workspace.getConfiguration("typescript");
  const jsCfg = vscode.workspace.getConfiguration("javascript");

  const updates: Thenable<void>[] = [];

  updates.push(editorCfg.update("quickSuggestions", enabled ? false : true, target));
  updates.push(editorCfg.update("suggestOnTriggerCharacters", enabled ? false : true, target));
  updates.push(editorCfg.update("wordBasedSuggestions", enabled ? "off" : "on", target));
  updates.push(editorCfg.update("parameterHints.enabled", enabled ? false : true, target));
  updates.push(editorCfg.update("hover.enabled", enabled ? false : true, target));
  updates.push(editorCfg.update("lightbulb.enabled", enabled ? false : true, target));
  updates.push(editorCfg.update("acceptSuggestionOnEnter", enabled ? "off" : "on", target));
  updates.push(editorCfg.update("tabCompletion", enabled ? "off" : "on", target));
  updates.push(editorCfg.update("inlineSuggest.enabled", enabled ? false : true, target));

  updates.push(tsCfg.update("suggest.autoImports", enabled ? false : true, target));
  updates.push(jsCfg.update("suggest.autoImports", enabled ? false : true, target));

  await Promise.all(updates.map((t) => Promise.resolve(t)));
}

export async function activate(context: vscode.ExtensionContext) {
  console.log("boj-mock-test activated");

  const langSpecs = buildLangSpecs();
  const problemCache = new Map<number, ProblemPagePayload>();

  let sessionRootDir: vscode.Uri | null = null;
  let currentProblemDocUri: vscode.Uri | null = null;
  let currentWorkDir: vscode.Uri | null = null;

  let pidToWorkDir = new Map<number, vscode.Uri>();
  let isRandomModeGlobal = false;

  const viewProvider = new BojMockTestViewProvider(context);
  console.log("registered view provider:", BojMockTestViewProvider.viewType);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(BojMockTestViewProvider.viewType, viewProvider));

  const toggleHandCoding = vscode.commands.registerCommand("boj-mock-test.toggleHandCoding", async () => {
    const current = context.globalState.get<boolean>(HAND_CODING_KEY, false);

    if (current) {
      await applyHandCodingMode(false);
      await context.globalState.update(HAND_CODING_KEY, false);
      viewProvider.postHandCodingState(false);
      vscode.window.showInformationMessage("손코딩 모드 OFF");
      return;
    }

    await applyHandCodingMode(true);
    await context.globalState.update(HAND_CODING_KEY, true);
    viewProvider.postHandCodingState(true);
    vscode.window.showInformationMessage("손코딩 모드 ON");
  });
  context.subscriptions.push(toggleHandCoding);

  function getBaseDirForRuns() {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    return ws ?? context.globalStorageUri;
  }

  async function ensureSessionDir(): Promise<vscode.Uri> {
    const base = getBaseDirForRuns();
    const sid = sessionIdNow();
    const root = vscode.Uri.joinPath(base, ".boj-mock-test", "runs", sid);
    await vscode.workspace.fs.createDirectory(root);
    sessionRootDir = root;
    return root;
  }

  function problemFolderUriManual(root: vscode.Uri, problemId: number, titleForName: string, langId: LanguageId) {
    const name = safeFilename(`${problemId}_${titleForName}_${langId}`).slice(0, 80);
    return vscode.Uri.joinPath(root, name);
  }

  function problemFolderUriRandom(root: vscode.Uri, idx1: number) {
    const name = safeFilename(`random_${idx1}_${randToken(8)}`).slice(0, 80);
    return vscode.Uri.joinPath(root, name);
  }

  async function pickValidByFetching(
    candidates: PickedProblem[],
    need: number,
    opts?: { requireSamples?: boolean; maxTryMultiplier?: number }
  ): Promise<PickedProblem[]> {
    const requireSamples = opts?.requireSamples ?? false;
    const maxTry = Math.max(need, 1) * (opts?.maxTryMultiplier ?? 30);

    const pool = shuffle(candidates);
    const picked: PickedProblem[] = [];

    for (let i = 0; i < pool.length && picked.length < need && i < maxTry; i++) {
      const c = pool[i];

      try {
        const payload = await fetchProblemPage(c.problemId);

        // 캐시도 같이 채워두면 이후 화면 표시가 빨라집니다.
        // (문제 수가 많으면 메모리/요청량은 늘어납니다.)
        // problemCache는 activate 스코프에 있으니 여기서 접근 가능해야 합니다.
        // -> 함수가 activate 내부에 있으면 그대로 접근 가능합니다.
        problemCache.set(c.problemId, payload);

        if (requireSamples && (!payload.samples || payload.samples.length === 0)) {
          continue;
        }

        picked.push({ problemId: c.problemId, title: c.title });
      } catch {
        // 파싱 실패/접근 제한 등은 그냥 스킵
        continue;
      }
    }

    return picked;
  }

  async function closeCurrentProblemEditorIfAny() {
    if (!currentProblemDocUri) return;
    const target = currentProblemDocUri.toString();

    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === target) {
        await vscode.window.showTextDocument(editor.document, {
          viewColumn: editor.viewColumn,
          preview: false,
          preserveFocus: false,
        });
        await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        break;
      }
    }
    currentProblemDocUri = null;
    currentWorkDir = null;
  }

  async function openSingleEditorForProblem(problemId: number, title: string, revealMeta: boolean, lang: LangSpec) {
    await closeCurrentProblemEditorIfAny();

    const folderUri = pidToWorkDir.get(problemId);
    if (!folderUri) throw new Error("문제 작업 폴더가 없습니다.");

    await vscode.workspace.fs.createDirectory(folderUri);

    const fileUri = vscode.Uri.joinPath(folderUri, lang.filename);

    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      const content = Buffer.from(makeTemplate(problemId, title, revealMeta, lang), "utf8");
      await vscode.workspace.fs.writeFile(fileUri, content);
    }

    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Two,
      preview: false,
      preserveFocus: false,
    });

    currentProblemDocUri = fileUri;
    currentWorkDir = folderUri;
  }

  let timerEndAt: number | null = null;
  let timerHandle: NodeJS.Timeout | null = null;

  function stopTimer(panel?: vscode.WebviewPanel) {
    timerEndAt = null;
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    if (panel) panel.webview.postMessage({ type: "timer", text: "00:00:00" });
  }

  function startTimer(minutes: number, panel?: vscode.WebviewPanel) {
    timerEndAt = Date.now() + minutes * 60 * 1000;

    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      if (!timerEndAt) return;
      const left = timerEndAt - Date.now();
      if (panel) panel.webview.postMessage({ type: "timer", text: fmt(left) });

      if (left <= 0) {
        clearInterval(timerHandle!);
        timerHandle = null;
        vscode.window.showWarningMessage("시험 시간이 종료되었습니다.");
      }
    }, 250);

    if (panel) panel.webview.postMessage({ type: "timer", text: fmt(timerEndAt - Date.now()) });
  }

  function buildFinishLinks(pickedProblems: PickedProblem[]) {
    return pickedProblems.map((p, idx) => {
      const pid = p.problemId;
      return {
        label: `문제 ${idx + 1}`,
        submitUrl: `https://www.acmicpc.net/submit/${pid}`,
        statusUrl: `https://www.acmicpc.net/status?problem_id=${pid}`,
        problemUrl: `https://www.acmicpc.net/problem/${pid}`,
      };
    });
  }

  async function prefetch3(picked: PickedProblem[], startIndex: number) {
    const max = Math.min(picked.length, startIndex + 3);
    const tasks: Array<Promise<void>> = [];
    for (let i = startIndex; i < max; i++) {
      const pid = picked[i].problemId;
      if (problemCache.has(pid)) continue;
      tasks.push(
        (async () => {
          const payload = await fetchProblemPage(pid);
          problemCache.set(pid, payload);
        })()
      );
    }
    await Promise.allSettled(tasks);
  }

  const disposable = vscode.commands.registerCommand("boj-mock-test.pick3", async () => {
    const langPick = await vscode.window.showQuickPick(
      [
        { label: "Python", value: "py" as const },
        { label: "JavaScript", value: "js" as const },
        { label: "Kotlin", value: "kt" as const },
        { label: "Java", value: "java" as const },
        { label: "C++", value: "cpp" as const },
        { label: "C", value: "c" as const },
      ],
      { placeHolder: "풀이 언어 선택" }
    );
    if (!langPick) return;

    const lang = langSpecs[langPick.value];

    const mode = await vscode.window.showQuickPick(
      [
        { label: "랜덤 문제", value: "random" as const },
        { label: "문제 번호 직접 입력", value: "manual" as const },
      ],
      { placeHolder: "모드 선택" }
    );
    if (!mode) return;

    const countStr = await vscode.window.showInputBox({
      prompt: "문제 개수",
      value: "3",
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!/^\d+$/.test(v.trim())) return "숫자를 입력하세요.";
        const n = Number(v);
        if (n <= 0) return "1 이상이어야 합니다.";
        if (n > 10) return "최대 10문제까지 가능합니다.";
        return null;
      },
    });
    if (!countStr) return;

    const problemCount = Number(countStr);

    const isRandomMode = mode.value === "random";
    isRandomModeGlobal = isRandomMode;

    let picked: PickedProblem[] = [];

    if (mode.value === "manual") {
      const idsStr = await vscode.window.showInputBox({
        prompt: `문제 번호 ${problemCount}개 (예: 1000, 2557, ...)`,
        ignoreFocusOut: true,
        validateInput: (v) => {
          const ids = v.split(/[,\s]+/).filter(Boolean);
          if (ids.length !== problemCount) return `문제 번호 ${problemCount}개를 입력하세요.`;
          if (!ids.every((x) => /^\d+$/.test(x))) return "숫자만 입력하세요.";
          return null;
        },
      });
      if (!idsStr) return;

      const ids = idsStr
        .split(/[,\s]+/)
        .filter(Boolean)
        .map((x) => Number(x));

      picked = ids.map((id) => ({ problemId: id, title: `BOJ ${id}` }));
    } else {
      const handle = await vscode.window.showInputBox({
        prompt: "사용자의 백준 ID를 입력해주세요 (사용자가 이미 푼 문제는 제외하기 위함)",
        placeHolder: "예: gildong123",
        ignoreFocusOut: true,
      });

      if (!handle) return;

      const tierPick = await vscode.window.showQuickPick(
        [
          { label: "Bronze 1 ~ Gold 4", min: "b1", max: "g4" },
          { label: "Bronze 1 ~ Silver 1", min: "b1", max: "s1" },
          { label: "Silver 5 ~ Gold 4", min: "s5", max: "g4" },
          { label: "Gold 5 ~ Gold 4", min: "g5", max: "g4" },
          { label: "직접 입력", min: "", max: "" },
        ],
        { placeHolder: "난이도 범위 선택" }
      );

      if (!tierPick) return;

      let minTier = tierPick.min;
      let maxTier = tierPick.max;

      if (tierPick.label === "직접 입력") {
        const minStr = (await vscode.window.showInputBox({
          prompt: "min tier 입력 (예: b1, s5, g3, p2)",
          ignoreFocusOut: true,
          validateInput: (v) => (/^[bsgp][1-5]$/i.test(v.trim()) ? null : "예: b1, s5, g3, p2 형태로 입력하세요."),
        }))?.trim().toLowerCase();

        if (!minStr) return;

        const maxStr = (await vscode.window.showInputBox({
          prompt: "max tier 입력 (예: g4)",
          ignoreFocusOut: true,
          validateInput: (v) => (/^[bsgp][1-5]$/i.test(v.trim()) ? null : "예: b1, s5, g3, p2 형태로 입력하세요."),
        }))?.trim().toLowerCase();

        if (!maxStr) return;

        minTier = minStr;
        maxTier = maxStr;
      }

      const candidates = await fetchCandidates(handle, minTier, maxTier);
      if (candidates.length < problemCount) {
        vscode.window.showWarningMessage(`조건에 맞는 문제가 ${problemCount}개 미만입니다.`);
        return;
      }

      const valid = await pickValidByFetching(
        candidates.map((x) => ({ problemId: x.problemId, title: x.title })),
        problemCount,
        { requireSamples: true, maxTryMultiplier: 50 }
      );

      if (valid.length < problemCount) {
        vscode.window.showWarningMessage(`조건에 맞는 "유효한 문제"를 충분히 찾지 못했습니다. (찾음: ${valid.length}/${problemCount})`);
        return;
      }

      picked = valid;
    }

    const timeStr = await vscode.window.showInputBox({
      prompt: "시험 시간(분)",
      value: "90",
      ignoreFocusOut: true,
      validateInput: (v) => (/^\d+$/.test(v.trim()) ? null : "숫자(분)만 입력하세요."),
    });

    if (!timeStr) return;
    const minutes = Number(timeStr);

    // 캐시 초기화
    problemCache.clear();
    pidToWorkDir = new Map<number, vscode.Uri>();

    const root = await ensureSessionDir();

    for (let i = 0; i < picked.length; i++) {
      const p = picked[i];
      const folderUri = isRandomMode ? problemFolderUriRandom(root, i + 1) : problemFolderUriManual(root, p.problemId, p.title, lang.id);

      pidToWorkDir.set(p.problemId, folderUri);
      await vscode.workspace.fs.createDirectory(folderUri);
    }

    const panel = vscode.window.createWebviewPanel("bojMockTest", "BOJ Mock Test", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });

    panel.webview.html = getWebviewHtml(panel.webview);

    // 3개 선로딩 + 캐싱, 그리고 1번 문제 바로 표시
    async function showFirstProblemImmediately() {
      if (!picked.length) return;
      const firstPid = picked[0].problemId;

      // 1) 최소 1번 문제는 즉시 확보
      if (!problemCache.has(firstPid)) {
        const payload1 = await fetchProblemPage(firstPid);
        problemCache.set(firstPid, payload1);
      }

      // 2) 첫 3개를 추가로 프리패치 (백그라운드)
      void prefetch3(picked, 0);

      const payload = problemCache.get(firstPid);
      if (!payload) return;

      panel.webview.postMessage({ type: "problemContent", payload });
      await openSingleEditorForProblem(firstPid, payload.title, !isRandomMode, lang);

      // 3) 리스트에서 첫 문제 활성 표시
      panel.webview.postMessage({ type: "init", problems: picked, hideMeta: isRandomMode, activeProblemId: firstPid });
    }

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ready") {
          const firstPid = picked[0]?.problemId ?? null;
          panel.webview.postMessage({ type: "init", problems: picked, hideMeta: isRandomMode, activeProblemId: firstPid });
          startTimer(minutes, panel);

          if (picked.length) {
            await showFirstProblemImmediately();
          }
          return;
        }

        if (msg.type === "finishExam") {
          stopTimer(panel);

          const links = buildFinishLinks(picked);
          panel.webview.postMessage({ type: "examFinished", links });

          if (sessionRootDir) {
            await vscode.commands.executeCommand("revealFileInOS", sessionRootDir);
          }

          vscode.window.showInformationMessage("시험을 종료했습니다. 저장된 코드 폴더를 열었습니다.");
          return;
        }

        if (msg.type === "selectProblem") {
          const pid = Number(msg.problemId);
          const idx = picked.findIndex((x) => x.problemId === pid);

          if (idx >= 0) {
            await prefetch3(picked, idx);
            void prefetch3(picked, idx + 1);
          }

          let payload = problemCache.get(pid);
          if (!payload) {
            payload = await fetchProblemPage(pid);
            problemCache.set(pid, payload);
          }

          panel.webview.postMessage({ type: "problemContent", payload });
          await openSingleEditorForProblem(pid, payload.title, !isRandomMode, lang);
          return;
        }

        // 개별 샘플 Run
        if (msg.type === "runOneSample") {
          const pid = Number(msg.problemId);
          const idx = Number(msg.idx);

          const payload = problemCache.get(pid);
          if (!payload) throw new Error("문제 데이터가 없습니다.");
          if (!currentProblemDocUri) throw new Error("코드 파일이 열려있지 않습니다.");
          if (!currentWorkDir) throw new Error("작업 디렉터리가 없습니다.");

          if (Number.isNaN(idx) || idx < 0 || idx >= payload.samples.length) throw new Error("예제 인덱스가 잘못되었습니다.");

          const srcPath = currentProblemDocUri.fsPath;
          const workDirPath = currentWorkDir.fsPath;

          const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === currentProblemDocUri!.toString());
          if (doc?.isDirty) await doc.save();

          const timeoutMs = 2000;
          const r = await gradeOne(lang, srcPath, workDirPath, payload.samples[idx], timeoutMs);

          const html = `
            <div>
              ${runResultRow(idx + 1, r.ok, r.ok ? "" : r.detail)}
            </div>
          `;

          panel.webview.postMessage({
            type: "runOutput",
            summaryText: r.ok ? `예제 ${idx + 1} PASS` : `예제 ${idx + 1} FAIL`,
            html,
          });
          panel.webview.postMessage({ type: "runDone" });
          return;
        }

        // 개별 커스텀 Run (번호는 webview에서 계산해 보내줌)
        if (msg.type === "runOneCustom") {
          const pid = Number(msg.problemId);
          const exampleNo = Number(msg.exampleNo);
          const input = String(msg.input ?? "");
          const expected = String(msg.expected ?? "");

          if (!problemCache.has(pid)) throw new Error("문제 데이터가 없습니다.");
          if (!currentProblemDocUri) throw new Error("코드 파일이 열려있지 않습니다.");
          if (!currentWorkDir) throw new Error("작업 디렉터리가 없습니다.");

          const srcPath = currentProblemDocUri.fsPath;
          const workDirPath = currentWorkDir.fsPath;

          const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === currentProblemDocUri!.toString());
          if (doc?.isDirty) await doc.save();

          const timeoutMs = 2000;

          if (expected && expected.trim()) {
            const r = await gradeOne(lang, srcPath, workDirPath, { input, output: expected }, timeoutMs);
            const html = `
              <div>
                ${runResultRow(exampleNo, r.ok, r.ok ? "" : r.detail)}
              </div>
            `;
            panel.webview.postMessage({
              type: "runOutput",
              summaryText: r.ok ? `예제 ${exampleNo} PASS` : `예제 ${exampleNo} FAIL`,
              html,
            });
            panel.webview.postMessage({ type: "runDone" });
            return;
          }

          const r2 = await runOnly(lang, srcPath, workDirPath, input, timeoutMs);
          const html2 = `
            <div>
              ${runCustomRow(`예제 ${exampleNo}`, r2.ok, r2.detail)}
            </div>
          `;
          panel.webview.postMessage({
            type: "runOutput",
            summaryText: r2.ok ? `예제 ${exampleNo} 실행 완료` : `예제 ${exampleNo} 실행 실패`,
            html: html2,
          });
          panel.webview.postMessage({ type: "runDone" });
          return;
        }

        // 전체 Run (샘플 + 커스텀)
        if (msg.type === "runAll") {
          const pid = Number(msg.problemId);
          const custom = Array.isArray(msg.cases) ? msg.cases : [];

          const payload = problemCache.get(pid);
          if (!payload) throw new Error("문제 데이터가 없습니다.");
          if (!currentProblemDocUri) throw new Error("코드 파일이 열려있지 않습니다.");
          if (!currentWorkDir) throw new Error("작업 디렉터리가 없습니다.");

          const srcPath = currentProblemDocUri.fsPath;
          const workDirPath = currentWorkDir.fsPath;

          const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === currentProblemDocUri!.toString());
          if (doc?.isDirty) await doc.save();

          const timeoutMs = 2000;

          let allOk = true;
          let rows = "";

          // 1) BOJ 샘플
          for (let i = 0; i < payload.samples.length; i++) {
            const r = await gradeOne(lang, srcPath, workDirPath, payload.samples[i], timeoutMs);
            if (!r.ok) allOk = false;
            rows += runResultRow(i + 1, r.ok, r.ok ? "" : r.detail);
          }

          // 2) 커스텀 (번호 이어붙이기)
          const base = payload.samples.length;
          for (let j = 0; j < custom.length; j++) {
            const exampleNo = base + j + 1;
            const input = String(custom[j]?.input ?? "");
            const expected = String(custom[j]?.output ?? "");

            if (expected && expected.trim()) {
              const r = await gradeOne(lang, srcPath, workDirPath, { input, output: expected }, timeoutMs);
              if (!r.ok) allOk = false;
              rows += runResultRow(exampleNo, r.ok, r.ok ? "" : r.detail);
              continue;
            }

            const r2 = await runOnly(lang, srcPath, workDirPath, input, timeoutMs);
            if (!r2.ok) allOk = false;
            rows += runCustomRow(`예제 ${exampleNo}`, r2.ok, r2.detail);
          }

          const html = `
            <div>
              ${rows}
            </div>
          `;

          panel.webview.postMessage({
            type: "runOutput",
            summaryText: "",
            html,
            mode: "all",
          });
          panel.webview.postMessage({ type: "runDone" });
          return;
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        panel.webview.postMessage({ type: "error", message: m });
      }
    });
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}
