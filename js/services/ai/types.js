/**
 * @file types.js
 * AI service type definitions (JSDoc only — no runtime code).
 * These types form the contract between callers and the AI layer.
 * Swap providers in gemini.js without touching request/response shapes.
 */

/**
 * Filters and context passed alongside a prompt.
 *
 * @typedef {Object} AIRequest
 * @property {string}            promptText       - The full prompt to send.
 * @property {Array<Object>}     tradeData        - Raw trades from journalData.trades.
 * @property {string}            [requestId]      - Caller-supplied trace ID; auto-generated if absent.
 * @property {string}            [accountFilter]  - Broker account ID or 'all'.
 * @property {{start:string, end:string}} [dateRange] - ISO date strings (inclusive).
 * @property {string}            [instrumentType] - 'stock' | 'option' | 'crypto' | 'futures' | 'all'.
 * @property {string}            [strategyFilter] - Strategy name or 'all'.
 * @property {string}            [styleFilter]    - Trading style or 'all'.
 * @property {Object}            [metadata]       - Any extra caller context.
 */

/**
 * Per-request provider overrides. All fields are optional; defaults live in each provider file.
 *
 * @typedef {Object} ProviderConfig
 * @property {string} [model]           - Override default model name.
 * @property {number} [temperature]     - 0–1. Default: 0.7.
 * @property {number} [maxOutputTokens] - Default: 2048.
 */

/**
 * Normalised response returned to all callers regardless of provider.
 * rawText is always freeform — callers decide how to render it.
 *
 * @typedef {Object} AIResponse
 * @property {boolean} success         - Whether the call succeeded.
 * @property {string}  rawText         - Freeform AI output (markdown or plain text). Always a string.
 * @property {string}  provider        - Provider identifier, e.g. 'gemini'.
 * @property {string}  model           - Model name used, e.g. 'gemini-flash-lite-latest'.
 * @property {string}  requestId       - Trace ID matching the originating AIRequest.
 * @property {number}  durationMs      - Total elapsed time for this request in milliseconds.
 * @property {string}  [error]         - Safe user-facing error message when success=false.
 * @property {string}  createdAt       - ISO timestamp of the response.
 * @property {{promptTokens:number, completionTokens:number, totalTokens:number}} [usage]
 */

/**
 * Compact, normalised trade sent to the AI (stripped of internal fields).
 *
 * @typedef {Object} FormattedTrade
 * @property {string}  symbol
 * @property {string}  direction        - 'long' | 'short'
 * @property {string}  assetType        - 'stock' | 'option' | 'crypto' | 'futures'
 * @property {number}  quantity
 * @property {number}  entryPrice
 * @property {number}  exitPrice
 * @property {string}  entryTime        - ISO timestamp
 * @property {string}  exitTime         - ISO timestamp
 * @property {number}  holdSeconds
 * @property {number}  pnl
 * @property {string}  [setupType]      - Strategy name
 * @property {number}  [strategyScore]  - 0–100
 * @property {string}  [emotion]
 * @property {string[]} [tags]
 * @property {string}  [entryReason]
 * @property {string}  [exitReason]
 * @property {string}  [lessons]
 * @property {string}  [optionType]     - 'call' | 'put'
 * @property {number}  [strike]
 * @property {string}  [expiry]         - YYYY-MM-DD
 */
