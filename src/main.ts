import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import axios from "axios";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const API_URL: string = core.getInput("API_URL")
const API_KEY: string = core.getInput('API_KEY')
const MODEL_NAME: string = core.getInput('MODEL_NAME')
const PROMPT_NAME: string = core.getInput('PROMPT_NAME')
// const BASE_URL: string | null = core.getInput("BASE_URL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openAiConfig: {baseUrl?: string| null, apiKey: string} = {
  apiKey: OPENAI_API_KEY
}

// if (BASE_URL !== '') {
// 	openAiConfig.baseUrl = BASE_URL
// }

const openai = new OpenAI(openAiConfig);

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
    owner: string,
    repo: string,
    pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

const generateAIResponse = async (prompt: string, apiUrl: string, apiKey: string) => {
  let modelName = MODEL_NAME
  if (!MODEL_NAME) {
    modelName = 'gpt-4o-mini'
  }
  let data = JSON.stringify({
    "user_prompt": prompt,
    "model_name": modelName,
    ...(PROMPT_NAME && { "prompt_name": PROMPT_NAME })
  });

  let config = {
    method: 'post',
    maxBodyLength: Infinity,
    url: apiUrl,
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json'
    },
    data : data
  };
  try {
    console.log("CONFIG", config)
    let response = await axios.request(config);
    console.log("RESPONSE", response['data'])
    response = response['data']['response'].trim().replace('```json', '')
    console.log("RESPONSE", response)
    const usefulResponse = JSON.parse(response['data']['response']);
    console.log("RESPONSE", usefulResponse)
    return usefulResponse.reviews;
  } catch (e) {
    console.log('Error occurred while calling api', e)
    return null
  }
}

// const generateAIResponse1 = async (prompt: string, apiUrl: string, apiKey: string) => {
//   let data = JSON.stringify({
//     "user_prompt": prompt
//   });
//
//   let config = {
//     method: 'post',
//     maxBodyLength: Infinity,
//     url: apiUrl,
//     headers: {
//       'Content-Type': 'application/json',
//       'X-API-Key': apiKey
//     },
//     data : data
//   };
//   try {
//     const response: any = await axios.request(config)
//     const usefulResponse = JSON.parse(response['response'])
//     return usefulResponse.reviews.trim().replace('```json', '');
//   } catch (e) {
//     console.log('Error occurred while calling api', e)
//     return null
//   }
// }

async function analyzeCode(
    parsedDiff: File[],
    prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      console.error("prompt to analyze", prompt)
      // const aiResponse = await getAIResponse(prompt);
      const aiResponse = await generateAIResponse(prompt, API_URL, API_KEY)
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `
diff
${chunk.content}
${chunk.changes
      // @ts-expect-error - ln and ln2 exists where needed
      .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
      .join("\n")}
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...((OPENAI_API_MODEL === "gpt-4-1106-preview")
              ? { response_format: { type: "json_object" } }
              : { }
      ),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    console.error("response of model", response)
    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error parsing:", error);
    return null;
  }
}

function createComment(
    file: File,
    chunk: Chunk,
    aiResponses: Array<{
      lineNumber: string;
      reviewComment: string;
    }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
    owner: string,
    repo: string,
    pull_number: number,
    comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
      .getInput("exclude")
      .split(",")
      .map((s) => s.trim());

  // @ts-ignore
  const filteredDiff = parsedDiff.filter((file: { to: any; }) => {
    return !excludePatterns.some((pattern: any) =>
        minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
