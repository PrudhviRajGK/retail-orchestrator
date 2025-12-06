const axios = require("axios");

async function createJiraTicket(summary, description) {
  try {
    const email = process.env.JIRA_EMAIL;
    const token = process.env.JIRA_API_TOKEN;
    const site = process.env.JIRA_SITE;
    const projectKey = process.env.JIRA_PROJECT_KEY;

    if (!email || !token || !site || !projectKey) {
      console.error("❌ Jira env missing");
      return { success: false, error: "Missing Jira environment variables" };
    }

    const payload = {
      fields: {
        project: { key: projectKey },
        summary,
        description,
        issuetype: { name: "Task" }
      }
    };

    const response = await axios.post(
      `${site}/rest/api/3/issue`,
      payload,
      {
        headers: { "Content-Type": "application/json" },
        auth: { username: email, password: token }
      }
    );

    console.log("✔ Jira ticket created:", response.data.key);

    return { success: true, issueKey: response.data.key };
  } catch (error) {
    console.error("❌ Jira create ticket error:", error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { createJiraTicket };
