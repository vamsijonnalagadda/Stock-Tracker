#!/usr/bin/env bash
set -euo pipefail

# Local deploy shortcut for stock-tracker
# Usage:
#   IMAGE_NAME=vamsi2654/stock-tracker IMAGE_TAG=latest DOCKERHUB_USER=vamsi2654 \
#     AZ_RESOURCE_GROUP=stock-tracker-rg AZ_CONTAINERAPPS_ENV=stock-tracker-env AZ_CONTAINERAPP_NAME=stock-tracker \
#     bash scripts/deploy_local.sh

IMAGE_NAME=${IMAGE_NAME:-vamsi2654/stock-tracker}
IMAGE_TAG=${IMAGE_TAG:-latest}
DOCKERHUB_USER=${DOCKERHUB_USER:-vamsi2654}
BUILD_CONTEXT=${BUILD_CONTEXT:-.}
BUILDER=${BUILDER:-aca-builder}

AZ_RESOURCE_GROUP=${AZ_RESOURCE_GROUP:-stock-tracker-rg}
AZ_CONTAINERAPPS_ENV=${AZ_CONTAINERAPPS_ENV:-stock-tracker-env}
AZ_CONTAINERAPP_NAME=${AZ_CONTAINERAPP_NAME:-stock-tracker}
AZ_TARGET_PORT=${AZ_TARGET_PORT:-4000}

echo "Deploy shortcut starting: image=${IMAGE_NAME}:${IMAGE_TAG}"

echo "Using Docker context: colima (switching)"
docker context use colima || true

echo "Recreating builder: $BUILDER"
docker buildx rm "$BUILDER" || true
docker buildx create --name "$BUILDER" --driver docker-container --driver-opt image=moby/buildkit:buildx-stable-1 --use
docker buildx inspect "$BUILDER" --bootstrap

echo "Registering QEMU emulation (no-op if already registered)"
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes || true

echo "Building and pushing amd64 image to Docker Hub"
docker buildx build --builder "$BUILDER" --platform linux/amd64 -t "${IMAGE_NAME}:${IMAGE_TAG}" --push "$BUILD_CONTEXT"

if command -v az >/dev/null 2>&1 && [ -n "${AZ_CONTAINERAPP_NAME:-}" ]; then
  echo "Updating Azure Container App: ${AZ_CONTAINERAPP_NAME} in ${AZ_RESOURCE_GROUP}"
  az containerapp update --name "$AZ_CONTAINERAPP_NAME" --resource-group "$AZ_RESOURCE_GROUP" --image "${IMAGE_NAME}:${IMAGE_TAG}" --set configuration.ingress.targetPort=$AZ_TARGET_PORT || \
    echo "Warning: az update failed or requires interactive login"
else
  echo "Skipping Azure Container Apps update (az CLI not found or AZ_CONTAINERAPP_NAME empty)"
fi

echo "Done."
