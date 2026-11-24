// Copyright (c) 2026 OneVector LLC
// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], pool: "forks" },
});
