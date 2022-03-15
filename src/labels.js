const core = require('@actions/core');
const github = require('@actions/github');

const owner = github.context.repo.owner;
const repo = github.context.repo.repo;

const colors = {
  success: '0E8A16', //Green
  failure: 'D93F0B', //Red
  cancelled: 'DEDEDE', //Gray
  skipped: 'DEDEDE', //Gray
  current: 'FBCA04', //Yellow
  default: 'C1B8FF' //Purple
};

async function listLabelsForRepo(octokit) {
  let hasMoreLabels = true;
  let labelsToReturn = [];
  let page = 1;
  const maxResultsPerPage = 40;

  try {
    core.info(`Retrieving the existing labels for this repository...`);

    while (hasMoreLabels) {
      const response = await octokit.rest.issues.listLabelsForRepo({
        owner,
        repo,
        per_page: maxResultsPerPage,
        page: page
      });

      if (response.status == 200) {
        if (response.data) {
          if (response.data.length < maxResultsPerPage) {
            hasMoreLabels = false;
          } else {
            page += 1;
          }

          for (let index = 0; index < response.data.length; index++) {
            let label = response.data[index];
            labelsToReturn.push(label.name.toLowerCase());
          }
        } else {
          core.info('Finished getting labels for the repository.');
        }
      } else {
        core.setFailed(`An error occurred retrieving page ${page} of labels.`);
      }
    }
    if (labelsToReturn.length > 0) {
      core.info(`The following labels were found in the ${owner}/${repo} repository: ${labelsToReturn.join(', ')}`);
      return labelsToReturn;
    }

    core.info(`No labels were found for the ${owner}/${repo} repository.`);
    return [];
  } catch (error) {
    core.info(`An error occurred while retrieving the labels for ${owner}/${repo}: ${error}`);
    return [];
  }
}

async function createLabel(octokit, name, color) {
  try {
    core.info(`Creating the ${name} label with color ${color}...`);
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name,
      color
    });
    core.info(`Successfully created the ${name} label.`);
  } catch (error) {
    core.setFailed(`An error occurred while creating the '${name}' label: ${error}`);
    throw error;
  }
}

async function addLabelToIssue(octokit, name, issue_number) {
  try {
    core.startGroup(`Adding label '${name}' to issue #${issue_number}...`);
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number,
      labels: [name]
    });
    core.info(`Successfully added label '${name}' to issue #${issue_number}...`);
    core.endGroup();
  } catch (error) {
    //Don't immediately fail by throwing, let it see what else it can finish.
    core.setFailed(`An error occurred while adding the '${name}' label from issue #${issue_number}: ${error}`);
    core.endGroup();
  }
}

async function removeLabelFromIssue(octokit, labelName, issue_number) {
  try {
    core.startGroup(`Removing label ${labelName} from issue #${issue_number}...`);
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number,
      name: labelName
    });
    core.info(`Successfully removed label ${labelName} from issue #${issue_number}.`);
    core.endGroup();
  } catch (error) {
    //Don't immediately fail by throwing, let it see what else it can finish.
    core.setFailed(`An error occurred while removing the '${labelName}' label from issue #${issue_number}: ${error}`);
    core.endGroup();
  }
}

async function removeStatusLabelsFromIssue(octokit, existingLabels, issueNumber, deployStatus) {
  try {
    core.startGroup(`Removing deployment status labels from issue #${issueNumber} if it has them.`);
    const hasSuccessLabel = existingLabels.indexOf('success') > -1;
    const hasFailureLabel = existingLabels.indexOf('failure') > -1;
    const hasCancelledLabel = existingLabels.indexOf('cancelled') > -1;
    const hasSkippedLabel = existingLabels.indexOf('skipped') > -1;

    const currentStatusIsSuccess = deployStatus === 'success';
    const currentStatusIsFailure = deployStatus === 'failure';
    const currentStatusIsCancelled = deployStatus === 'cancelled';
    const currentStatusIsSkipped = deployStatus === 'skipped';

    if (hasSuccessLabel && !currentStatusIsSuccess) await removeLabelFromIssue(octokit, 'success', issueNumber);
    if (hasFailureLabel && !currentStatusIsFailure) await removeLabelFromIssue(octokit, 'failure', issueNumber);
    if (hasCancelledLabel && !currentStatusIsCancelled) await removeLabelFromIssue(octokit, 'cancelled', issueNumber);
    if (hasSkippedLabel && !currentStatusIsSkipped) await removeLabelFromIssue(octokit, 'skipped', issueNumber);
    core.info(`Finished removing deployment status labels from issue #${issueNumber}.`);
    core.endGroup();
  } catch (error) {
    //Don't immediately fail by throwing, let it see what else it can finish.
    core.info(`An error occurred removing status labels from issue #${issueNumber}: ${error}`);
    core.endGroup();
  }
}

async function findIssuesWithLabel(graphqlWithAuth, labelName, deployableType) {
  try {
    core.startGroup(`Finding issuess with label '${labelName}'...`);

    const query = `
    query {
      repository(owner: "${owner}", name: "${repo}") {
        issues(first: 100, filterBy: {labels: ["${labelName}"]}) {
          edges {
            node {
              number,
              title
            }
          }
        }
      }
    }`;

    const response = await graphqlWithAuth(query);
    if (!response.repository.issues || !response.repository.issues.edges || response.repository.issues.edges.length === 0) {
      core.info(`There were no issues with label '${labelName}'.`);
      core.endGroup();
      return [];
    }

    if (deployableType && deployableType.length > 0) {
      const issues = response.repository.issues.edges
        .filter(ri => ri.node.title.toLowerCase().indexOf(deployableType.toLowerCase()) > -1)
        .map(ri => ri.node.number);
      core.info(`The following issues had label '${labelName} and deployable type: ${deployableType}': ${issues}`);
      core.endGroup();
      return issues;
    } else {
      const issues = response.repository.issues.edges.map(ri => ri.node.number);
      core.info(`The following issues had label '${labelName}': ${issues}`);
      core.endGroup();
      return issues;
    }
  } catch (error) {
    core.info(`An error occurred retrieving issues with the '${labelName}' label: ${error}`);
    core.info(`You may need to manually remove the ${labelName} from other issues`);
    core.endGroup();
    return [];
  }
}

async function makeSureLabelsForThisActionExist(octokit, labels) {
  core.startGroup(`Making sure the labels this action uses exist...`);
  existingLabelNames = await listLabelsForRepo(octokit);

  //Check to see if the labels we will be adding for this issue exist & create if they don't
  if (existingLabelNames.indexOf(labels.deployStatus) === -1) {
    labels.deployStatusExists = false;
    await createLabel(octokit, labels.deployStatus, colors[labels.deployStatus]);
  } else {
    core.info(`The ${labels.deployStatus} label exists.`);
  }

  if (existingLabelNames.indexOf(labels.currentlyInEnv) === -1) {
    labels.currentlyInEnvExists = false;
    await createLabel(octokit, labels.currentlyInEnv, colors['current']);
  } else {
    core.info(`The ${labels.currentlyInEnv} label exists.`);
  }

  if (existingLabelNames.indexOf(labels.default) === -1) {
    labels.defaultExists = false;
    await createLabel(octokit, labels.default, colors['default']);
  } else {
    core.info(`The ${labels.default} label exists.`);
  }
  core.info(`Finished checking that the labels exist.`);
  core.endGroup();
}

module.exports = {
  findIssuesWithLabel,
  addLabelToIssue,
  removeLabelFromIssue,
  removeStatusLabelsFromIssue,
  makeSureLabelsForThisActionExist
};
