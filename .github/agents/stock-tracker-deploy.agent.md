---
name: stock-tracker-deploy
description: |
  Deploy helper for stock-tracker: builds amd64 image and deploys to Docker Hub and Azure Container Apps.
  Use when: "deploy", "build amd64", "push to docker hub", "deploy to aca"
---

# stock-tracker deploy agent (instructions)

This agent automates the common deployment steps for this repo.

Steps:

1. Ensure VM-backed Docker context is active (Colima recommended):
   - `colima start --arch x86_64 --vm-type vz --vz-rosetta`
   - `docker context use colima`

2. Ensure builder exists and is bootstrapped:
   - `docker buildx rm aca-builder || true`
   - `docker buildx create --name aca-builder --driver docker-container --driver-opt image=moby/buildkit:buildx-stable-1 --use`
   - `docker buildx inspect aca-builder --bootstrap`

3. Build and push amd64 image to Docker Hub:
   - `docker run --rm --privileged multiarch/qemu-user-static --reset -p yes`
   - `docker buildx build --builder aca-builder --platform linux/amd64 -t vamsi2654/stock-tracker:latest --push .`

4. Deploy to Azure Container Apps (existing app `stock-tracker` in `stock-tracker-rg`):
   - `az containerapp update --name stock-tracker --resource-group stock-tracker-rg --image vamsi2654/stock-tracker:latest --set configuration.ingress.targetPort=4000`

5. Optional: use the repository helper script:
   - `IMAGE_NAME=vamsi2654/stock-tracker IMAGE_TAG=latest DOCKERHUB_USER=vamsi2654 AZ_RESOURCE_GROUP=stock-tracker-rg AZ_CONTAINERAPPS_ENV=stock-tracker-env AZ_CONTAINERAPP_NAME=stock-tracker bash scripts/deploy_containers.sh`

Secrets/Requirements:
- Docker Hub login: `docker login`
- Azure CLI logged in and subscription set: `az login` and `az account set --subscription "POC"`

Keywords: `deploy`, `build`, `amd64`, `dockerhub`, `aca`, `colima`, `buildx`
