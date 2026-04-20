#!/usr/bin/env bash
set -euo pipefail

# deploy_containers.sh
# Builds a Docker image, pushes to Docker Hub and to Azure Container Registry (ACR).
# Usage: export variables below, then run this script.

if [ "$#" -gt 0 ] && [ "$1" = "--help" ]; then
  cat <<EOF
Usage: 
  IMAGE_NAME=my-app IMAGE_TAG=latest \
  DOCKERHUB_USER=myuser DOCKERHUB_REPO=myrepo DOCKERHUB_TAG=latest \
  ACR_NAME=myacr ACR_REPO=myrepo ACR_TAG=latest \
  bash scripts/deploy_containers.sh

Environment variables (defaults shown):
  IMAGE_NAME       - local image name (required)
  IMAGE_TAG        - image tag (default: latest)
  BUILD_CONTEXT    - build context (default: .)
  DOCKERHUB_USER   - Docker Hub username (required to push)
  DOCKERHUB_REPO   - Docker Hub repo (defaults to IMAGE_NAME)
  DOCKERHUB_TAG    - Docker Hub tag (defaults to IMAGE_TAG)
  ACR_NAME         - Azure Container Registry name (required to push to ACR)
  ACR_REPO         - ACR repo path (defaults to IMAGE_NAME)
  ACR_TAG          - ACR tag (defaults to IMAGE_TAG)
EOF
  exit 0
fi

IMAGE_NAME=${IMAGE_NAME:-}
IMAGE_TAG=${IMAGE_TAG:-latest}
BUILD_CONTEXT=${BUILD_CONTEXT:-.}

if [ -z "$IMAGE_NAME" ]; then
  echo "ERROR: IMAGE_NAME must be set" >&2
  exit 2
fi

DOCKERHUB_USER=${DOCKERHUB_USER:-}
DOCKERHUB_REPO=${DOCKERHUB_REPO:-$IMAGE_NAME}
DOCKERHUB_TAG=${DOCKERHUB_TAG:-$IMAGE_TAG}

ACR_NAME=${ACR_NAME:-}
ACR_REPO=${ACR_REPO:-$IMAGE_NAME}
ACR_TAG=${ACR_TAG:-$IMAGE_TAG}

LOCAL_FULL="$IMAGE_NAME:$IMAGE_TAG"
DOCKERHUB_FULL="${DOCKERHUB_USER}/${DOCKERHUB_REPO}:${DOCKERHUB_TAG}"
ACR_FULL="${ACR_NAME}.azurecr.io/${ACR_REPO}:${ACR_TAG}"

echo "Building image $LOCAL_FULL from $BUILD_CONTEXT"
docker build -t "$LOCAL_FULL" "$BUILD_CONTEXT"

if [ -n "$DOCKERHUB_USER" ]; then
  echo "Tagging and pushing to Docker Hub: $DOCKERHUB_FULL"
  docker tag "$LOCAL_FULL" "$DOCKERHUB_FULL"
  echo "Make sure you've run: docker login"
  docker push "$DOCKERHUB_FULL"
else
  echo "Skipping Docker Hub push (DOCKERHUB_USER not set)"
fi

if [ -n "$ACR_NAME" ]; then
  echo "Pushing to Azure Container Registry: $ACR_FULL"
  echo "Logging into ACR: $ACR_NAME"
  az acr login --name "$ACR_NAME"
  docker tag "$LOCAL_FULL" "$ACR_FULL"
  docker push "$ACR_FULL"
else
  echo "Skipping ACR push (ACR_NAME not set)"
fi

echo "Done."
