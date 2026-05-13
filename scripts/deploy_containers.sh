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
  AZ_RESOURCE_GROUP - Azure resource group for Container App (required to deploy)
  AZ_CONTAINERAPPS_ENV - Azure Container Apps environment name (required to deploy)
  AZ_CONTAINERAPP_NAME - Container App name to create/update (if set, will deploy)
  AZ_INGRESS        - ingress type: "external" or "none" (default: external)
  AZ_TARGET_PORT    - target port for the container app (default: 80)
  AZ_REGISTRY_SERVER - registry server for private images (default: docker.io)
  AZ_REGISTRY_USERNAME - registry username (if private Docker Hub)
  AZ_REGISTRY_PASSWORD - registry password (if private Docker Hub)
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

# Optional: deploy to Azure Container Apps if AZ_CONTAINERAPP_NAME is set
AZ_RESOURCE_GROUP=${AZ_RESOURCE_GROUP:-}
AZ_CONTAINERAPPS_ENV=${AZ_CONTAINERAPPS_ENV:-}
AZ_CONTAINERAPP_NAME=${AZ_CONTAINERAPP_NAME:-}
AZ_INGRESS=${AZ_INGRESS:-external}
AZ_TARGET_PORT=${AZ_TARGET_PORT:-80}
AZ_REGISTRY_SERVER=${AZ_REGISTRY_SERVER:-docker.io}
AZ_REGISTRY_USERNAME=${AZ_REGISTRY_USERNAME:-}
AZ_REGISTRY_PASSWORD=${AZ_REGISTRY_PASSWORD:-}

if [ -n "$AZ_CONTAINERAPP_NAME" ]; then
  # Choose image URI: prefer ACR if pushed there, otherwise Docker Hub
  if [ -n "$ACR_NAME" ]; then
    IMAGE_URI="$ACR_FULL"
  else
    IMAGE_URI="$DOCKERHUB_FULL"
  fi

  if [ -z "$AZ_RESOURCE_GROUP" ] || [ -z "$AZ_CONTAINERAPPS_ENV" ]; then
    echo "ERROR: To deploy to Container Apps set AZ_RESOURCE_GROUP and AZ_CONTAINERAPPS_ENV" >&2
    exit 3
  fi

  echo "Deploying image $IMAGE_URI to Azure Container App: $AZ_CONTAINERAPP_NAME"

  # Check if container app exists
  if az containerapp show --name "$AZ_CONTAINERAPP_NAME" --resource-group "$AZ_RESOURCE_GROUP" >/dev/null 2>&1; then
    echo "Updating existing Container App $AZ_CONTAINERAPP_NAME"
    az containerapp update \
      --name "$AZ_CONTAINERAPP_NAME" \
      --resource-group "$AZ_RESOURCE_GROUP" \
      --image "$IMAGE_URI" \
      --ingress "$AZ_INGRESS" \
      --target-port "$AZ_TARGET_PORT" || true
  else
    echo "Creating Container App $AZ_CONTAINERAPP_NAME"
    # If registry creds provided, include them; otherwise rely on public image or existing registry access
    if [ -n "$AZ_REGISTRY_USERNAME" ] && [ -n "$AZ_REGISTRY_PASSWORD" ]; then
      az containerapp create \
        --name "$AZ_CONTAINERAPP_NAME" \
        --resource-group "$AZ_RESOURCE_GROUP" \
        --environment "$AZ_CONTAINERAPPS_ENV" \
        --image "$IMAGE_URI" \
        --ingress "$AZ_INGRESS" \
        --target-port "$AZ_TARGET_PORT" \
        --registry-server "$AZ_REGISTRY_SERVER" \
        --registry-username "$AZ_REGISTRY_USERNAME" \
        --registry-password "$AZ_REGISTRY_PASSWORD"
    else
      az containerapp create \
        --name "$AZ_CONTAINERAPP_NAME" \
        --resource-group "$AZ_RESOURCE_GROUP" \
        --environment "$AZ_CONTAINERAPPS_ENV" \
        --image "$IMAGE_URI" \
        --ingress "$AZ_INGRESS" \
        --target-port "$AZ_TARGET_PORT"
    fi
  fi
fi

echo "Done."
