#!/bin/sh
# Docker init: create a throwaway database for API integration tests (wiped on every test run).
psql -U "$POSTGRES_USER" -c 'create database fieldtrack_test'
