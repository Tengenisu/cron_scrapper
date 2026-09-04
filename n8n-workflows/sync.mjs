#!/usr/bin/env node
/**
 * Embeds scrape-and-dump.js into the "Scrape + MCP" Code node of
 * moneycontrol-earnings-scraper.json, so the workflow and the readable source
 * file can never drift apart.
 *
 *     npm run n8n:sync           # write the workflow
 *     npm run n8n:sync -- --check  # fail if it is out of date (CI-friendly)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowFile = path.join(here, "moneycontrol-earnings-scraper.json");
const codeFile = path.join(here, "scrape-and-dump.js");
const CODE_NODE = "Scrape + MCP";

const check = process.argv.includes("--check");

const workflow = JSON.parse(fs.readFileSync(workflowFile, "utf8"));
const code = fs.readFileSync(codeFile, "utf8");

const node = workflow.nodes.find((candidate) => candidate.name === CODE_NODE);
if (!node) {
  console.error(`No "${CODE_NODE}" node in ${path.basename(workflowFile)}.`);
  process.exit(1);
}

if (node.parameters.jsCode === code) {
  console.log("n8n workflow is already in sync.");
  process.exit(0);
}

if (check) {
  console.error(`${path.basename(workflowFile)} is out of date — run: npm run n8n:sync`);
  process.exit(1);
}

node.parameters.jsCode = code;
fs.writeFileSync(workflowFile, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
console.log(`Embedded ${path.basename(codeFile)} into ${path.basename(workflowFile)}.`);
