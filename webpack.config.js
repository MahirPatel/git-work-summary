//@ts-check

'use strict';

const path = require('path');
const fs = require('fs');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

/** Reads a single `KEY=value` line from a gitignored `.env` at the repo root; returns '' if the file or key is absent. */
function readEnvValue(key) {
  const envPath = path.resolve(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return '';
  }
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]'
  },
  externals: {
    // The vscode-module is created on-the-fly and must be excluded.
    // See https://webpack.js.org/configuration/externals/
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules|test/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.DEFAULT_GROQ_API_KEY': JSON.stringify(readEnvValue('DEFAULT_GROQ_API_KEY'))
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'node_modules/@vscode/codicons/dist/codicon.css'),
          to: path.resolve(__dirname, 'dist/codicons/codicon.css')
        },
        {
          from: path.resolve(__dirname, 'node_modules/@vscode/codicons/dist/codicon.ttf'),
          to: path.resolve(__dirname, 'dist/codicons/codicon.ttf')
        }
      ]
    })
  ],
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log'
  }
};

module.exports = [extensionConfig];
