---
title: "Azure Pipelines YAML validation: full throttle"
date: 2023-09-29T00:08:30Z
slug: ""
---

I have been using [Azure Pipelines](https://azure.microsoft.com/en-us/products/devops/pipelines) as my primary CI system of choice for few years now, and, while I don't find it perfect, I always feel big power inside its YAML templating and rich API capabilities. 

This post will be a guide on how to maintain a set of YAML templates for CI pipelines and validate changes to them. The set of YAML templates is commonly placed outside of application repos and are referenced by smaller portions of YAML on the corresponding app repos.

![image](/02-azd-validate-3.jpg)

So when a great amount of application repositories use the same central CI templates repository, it is pretty important to have all its changes validated on PR level.

First of all, there are a number of tools that help with validating Azure Pipelines:

* [online validator](https://yamlpipelinesvalidator.dev/) that you can invoke via API, but it won't understand your own elements like service connections, for example
* [VS Code extension](https://marketplace.visualstudio.com/items?itemName=TomAustin.azure-devops-yaml-pipeline-validator) that does something similar, but again unaware of your own project items
* Custom scripts created by enthusiasts ([example here](https://johnlokerse.dev/2022/02/07/validating-yaml-using-azure-devops-or-cli/)) that use Azure DevOps API to initiate a "PreviewRun" and respond with syntax errors

These are pretty nice tools, all of them are based on the available "Run Pipeline" API with an ability to provide custom pipeline definition. But they all hit an important obstacle: they work only if you can provide a single full YAML document to validate:

```
$Body = @{
  "PreviewRun"   = "true"
  "YamlOverride" = <INSERT_YAML>  <----- you have to provide this!
}
```

But what if you have a distributed structure of YAML templates, where your app repo yaml definition is just a pointer to a template that lives outside of it? And the tempate is composed of many building blocks, where jobs and steps are all templates themselves? Then we need to construct full YAML somehow, and I am unaware of any tools that can help you do that.

But there is a solution, another way to go, and I will describe it now.

With Azure DevOps API, you can trigger a preview run of an existing pipeline with overriding its run parameters. Inside that "run parameters" structure you can literally provide any possible configuration of a pipeline. This includes the "resources" structure, which we use to point to the external templates repository:

```
    run_client = PipelinesClient(
        base_url=ORGANIZATION_URL, 
        creds=credentials
    )
    ...
    pipeline_run = run_client.preview(
        project=PROJECT_NAME,
        pipeline_id=BUILD_DEFINITION_ID,
        run_parameters=input_parameters    <------ here is what we provide
    )
```

Where input_parameters are prematurely composed this way:

```
- task: Bash@3
  displayName: Prepare params.json
  inputs:
    targetType: 'inline'
    workingDirectory: ./scripts
    script: |
      cat > params.json <<EOF
      {
          "resources": {
              "repositories": {
                  "templates": {
                      "refName": "${BRANCH}",
                      "version": ""
                  }
              }
          }
      }
      EOF
      cat params.json
  env:
    BRANCH: $(System.PullRequest.SourceBranch)
```

So watch the hands: we fill in the `refName` of the "templates" repository with the branch name that comes from `$(System.PullRequest.SourceBranch)` predefined variable that is the originating branch of the changes we are committing to the repository, raising the PR! 

Using PipelinesClient() of the API, we are able to pass this customization to a preview of a pipeline. Notice that `preview()` is the special function that does exactly what we need: builds full YAML out of all the parts that get combined and prints it out to the output, where you can actually see all steps together:

![image](/02-azd-validate-1.png)

And, of course, if there are preview errors rendering this document - you get full reasonable error output to capture what is wrong:

![image](/02-azd-validate-2.png)

So now our validation sequence can look this way: 

1. We make a change to a repository with YAML templates in a branch;
2. We raise a PR to our 'main' branch;
3. A pipeline gets triggered that makes a YAML preview to detect any syntax issues.

Is this enough? Not exactly, so let's move on.

You may generate correct YAML syntax that will form a legitimate pipeline according to Azure DevOps Validator, but you can easily introduce a logical issue, when the resulting pipelines will fail in runtime. How to make sure we don't do THAT and annoy development teams as a result? "This devops guy broke our pipelines again and halts our work now"... Sounds familiar?

The next level is to run the most frequently used CI jobs for minimal sample apps of the used stack. In my example, I am going to show 2 kinds of applications: Spring Boot and React App. Let's form a matrix of those with their sample pipeline IDs:

```
variables:
  - name: matrix
    value: |
      {
        "reactApp": {
          "BUILD_DEFINITION_ID": "11"
        },
        "springBootApp": {
          "BUILD_DEFINITION_ID": "14"
        }
      }
```

The matrix here helps us create exactly the same jobs for two different apps:

```
- job: CheckBuilds
  strategy:
    matrix: $[ variables.matrix ]
    maxParallel: 1
```

Each of these build definitions points to the corresponding template on the templates repository, i.e. we use `extends` for that purpose, passing the required parameters. Here's an example of what's located on a React App repository:

```
extends:
  template: pipelines/nodejs.yaml@templates
  parameters:
    baseImage: nginx
    appGroup: demo
    projectSubdirectory: ./apps/react-demo
    containerImageName: react-demo
```

and "templates" is defined inside its resources section:

```
resources:
  repositories:
  # Repository with CI templates
  - repository: templates
    type: github
    name: artazar/azure-pipeline-templates
    endpoint: github
```

So we have an entrypoint for our app that points to nodejs.yaml pipeline template that lives on the external templates repository.

With the help of the same trick with params.json, it is possible to initiate a real job run for this pipeline, injecting the ref name of the templates repository to use the modified templates code.

This works absolutely fine, except for the fact that there's no "wait" parameter inside the API (bummer!). So I had to add my own piece of "wait" code to examine the pipeline run results:


```
    print("Queuing the build...\n")
    try:
        pipeline_run = run_client.run_pipeline(
            project=PROJECT_NAME,
            pipeline_id=BUILD_DEFINITION_ID,
            run_parameters=input_parameters
        )
    except AzureDevOpsServiceError as exception:
        print(exception)
        return False

    # Get the run ID from the response
    run_id = pipeline_run.id
    # Get run URL, example format:
    # https://dev.azure.com/PulseMusic/DevOps/_build/results?buildId=3644&view=logs
    run_url = ORGANIZATION_URL+"/"+PROJECT_NAME + \
        "/_build/results?buildId="+str(run_id)+"&view=logs"
    # print(run)   ### DEBUG
    print("A new build run was created with ID: {}\nBuild logs: {}\n".format(
        run_id, run_url))

    # Wait for the build to complete
    while True:
        try:
            run = run_client.get_run(
                project=PROJECT_NAME,
                pipeline_id=BUILD_DEFINITION_ID,
                run_id=run_id
            )
            if run.state == 'completed':
                result = run.result
                break
            print("Waiting for the build to complete...")
            time.sleep(15)
        except AzureDevOpsServiceError:
            pass

    if result == 'succeeded':
        print("The build has completed successfully!")
        return True
    else:
        print("The build has failed, please check its logs by following the URL:")
        print(run_url)
        return False
```

So now our validation sequence can look this way: 

1. We make a change to a repository with YAML templates in a branch;
2. We raise a PR to our 'main' branch;
3. A pipeline gets triggered that executes two important steps;
4. It makes a YAML preview to detect any syntax issues;
5. It triggers a new run of a demo app pipeline to detect any logical issues of the pipeline itself.

Is this enough? Not really. There's one more point to cover that we tend to forget about.

Ordinary job runs are great, but we almost certainly also have PR merge checks that can be a completely different set of pipeline steps. Usually we divide all our pipelines code into PR and non-PR actions. So how do we emulate PR builds... manually with API? 

Fortunately, there's a trick to do that too! But it comes with a tax to pay.

This is possible if we switch to BuildClient() instead of PipelinesClient():

```
    build_client = BuildClient(
        base_url=ORGANIZATION_URL,
        creds=credentials
    )

    # Create the build object with pullRequest reason
    build = Build(
        definition=build_definition,
        source_branch=SOURCE_BRANCH,
        reason='pullRequest',
    )
```

Sadly, the BuildClient() doesn't include injecting custom parameters to pass our branch name as we did before. So we can trigger a PR build, but we cannot use the changed templates to verify them...

True engineers do not give up!
Without any extra explanations, here's what helps in this case:

```
resources:
  repositories:
  # Repository with CI templates
  - repository: templates
    type: github
    name: artazar/azure-pipeline-templates
    endpoint: github
    ref: ${{ replace(variables['System.PullRequest.SourceBranch'], 'refs/heads/', '') }}
```

So we utilize the power of Azure Pipelines expressions that can calculate the "ref" value right on the fly out of the PR source branch.

(Cutting out 'refs/heads/' part is required, I know it looks a bit ugly, but couldn't solve this any other way.)

So now our validation sequence is composed of: 

1. We make a change to a repository with YAML templates;
2. We raise a PR to our 'main' stable branch;
3. A pipeline gets triggered that executes two important steps;
4. It makes a YAML preview to detect any syntax issues;
5. It triggers a new run of a demo app pipeline to detect any logical issues of the pipeline itself;
6. It triggers a new run of a demo app pipeline template with reason=pullRequest to initate the PR pipelines check.

Here's the flow depicted as diagram:

![image](/02-pipeline-diagram.jpg)

Being able to validate Azure Pipelines YAML, to check the branch builds and PR builds makes this whole procedure a complete and utmost verification of the changes done to CI templates. I would say that executing this full procedure is pretty heavy and takes some time to complete. But it is a great helper when introducing massive changes to pipeline templates, where you need verification that these changes will not result into any build failures.

Here's the source code that demonstrates this approach:

1. [validate-templates.yaml](https://github.com/artazar/azure-pipeline-templates/blob/main/pipelines/validate-templates.yaml) -- full definition of the validating pipeline
2. [previewBuildYaml.py](https://github.com/artazar/azure-pipeline-templates/blob/main/scripts/previewBuildYaml.py) -- the script that executes Preview API
3. [runAndWaitForBuildCompletionCustomParameters](https://github.com/artazar/azure-pipeline-templates/blob/main/scripts/runAndWaitForBuildCompletionCustomParameters.py) -- the script that runs a Pipeline with customized parameters
4. [runAndWaitForBuildCompletionReasonPR](https://github.com/artazar/azure-pipeline-templates/blob/main/scripts/runAndWaitForBuildCompletionReasonPR.py) -- the script that runs a Pipeline with Reason=PR
5. [azure-pipelines.yaml](https://github.com/artazar/azure-pipeline-templates/blob/main/apps/react-demo/azure-pipelines.yaml) - "entrypoint" yaml file for a Spring Boot sample app

I hope this material comes useful to community, as, pursuing this goal, I have not found a single tutorial to implement this full flow.

Cheers!