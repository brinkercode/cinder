# An S3 mirror of web-store's static assets. No flow plans it: the plan needs AWS credentials a dry run doesn't have.
terraform {
  required_version = "~> 1.13"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "assets" {
  bucket = "web-store-assets"
}
