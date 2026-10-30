#!/usr/bin/env node
'use strict';
// Печатает ключ модели для каждого артикула со стандартного ввода (по строке на артикул).
// Сверка с приложением «Склад»: см. tools/check_model_key.cpp в репозитории приложения - ключи должны совпасть.
const { splitSku } = require('../src/model');
const lines = require('fs').readFileSync(0, 'utf8').split('\n');
if (lines[lines.length - 1] === '') lines.pop();
process.stdout.write(lines.map((l) => splitSku(l.replace(/\r$/, '')).key).join('\n') + '\n');
