#!/usr/bin/env node

/**
 * In-process test runner for sandbox and CI environments
 */

import './doctor.test.mjs';
import './package-layout.test.mjs';
import './skill-discovery.test.mjs';
import './validate-handoff.test.mjs';
import './ws-transport.test.mjs';
import './openai-api.test.mjs';
import './tool-calls.test.mjs';
