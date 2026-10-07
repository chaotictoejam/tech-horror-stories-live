#!/usr/bin/env bash
# Destroys everything after the talk: all three stacks, the presenter key, and local outputs.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "This deletes the Tech Horror Stories stacks, tables, buckets, and logs in $(aws configure get region 2>/dev/null || echo 'your default region')."
read -r -p "Type 'destroy' to continue: " answer
[[ "$answer" == "destroy" ]] || { echo "Aborted."; exit 1; }

npx cdk destroy --all --force
aws ssm delete-parameter --name /tech-horror/presenter-key 2>/dev/null && echo "Deleted presenter key." || echo "No presenter key to delete."
rm -f cdk-outputs.json
echo "Done. Check the CloudFormation console for any stack stuck in DELETE_FAILED."
