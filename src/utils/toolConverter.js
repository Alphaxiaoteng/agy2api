// 工具转换公共模块
import { sanitizeToolName, cleanParameters } from './utils.js';
import { setToolNameMapping } from './toolNameCache.js';

/**
 * 将单个工具定义转换为 Antigravity 格式的 functionDeclaration
 * @param {string} name - 工具名称
 * @param {string} description - 工具描述
 * @param {Object} parameters - 工具参数 schema
 * @param {string} sessionId - 会话 ID
 * @param {string} actualModelName - 实际模型名称
 * @returns {Object} functionDeclaration 对象
 */
function convertSingleTool(name, description, parameters, sessionId, actualModelName) {
  const originalName = name;
  const safeName = sanitizeToolName(originalName);
  
  if (actualModelName && safeName !== originalName) {
    setToolNameMapping(actualModelName, safeName, originalName);
  }
  
  let rawParams = parameters || {};
  if (rawParams.jsonSchema && typeof rawParams.jsonSchema === 'object') {
    rawParams = rawParams.jsonSchema;
  } else if (rawParams.inputSchema && typeof rawParams.inputSchema === 'object') {
    rawParams = rawParams.inputSchema.jsonSchema || rawParams.inputSchema;
  }
  const cleanedParams = cleanParameters(rawParams) || {};
  // 使用大写 OBJECT 以匹配官方 API 格式
  if (cleanedParams.type === undefined) cleanedParams.type = 'OBJECT';
  else if (cleanedParams.type === 'object') cleanedParams.type = 'OBJECT';
  if ((cleanedParams.type === 'OBJECT' || cleanedParams.type === 'object') && cleanedParams.properties === undefined) cleanedParams.properties = {};
  //console.log(JSON.stringify(tool,null,2),100)
  return {
    name: safeName,
    description: description || '',
    parameters: cleanedParams
  };
}

/**
 * 将 OpenAI 格式的工具列表转换为 Antigravity 格式
 * OpenAI 格式: [{ type: 'function', function: { name, description, parameters } }]
 * 也支持字典对象格式: { [name]: { description, inputSchema } } (如 ZCode/AI SDK)
 * @param {Array|Object} openaiTools - OpenAI 格式的工具列表或字典
 * @param {string} sessionId - 会话 ID
 * @param {string} actualModelName - 实际模型名称
 * @returns {Array} Antigravity 格式的工具列表（所有工具在一个 functionDeclarations 数组中）
 */
export function convertOpenAIToolsToAntigravity(openaiTools, sessionId, actualModelName) {
  if (!openaiTools) return [];

  let toolsList = [];
  if (Array.isArray(openaiTools)) {
    toolsList = openaiTools;
  } else if (typeof openaiTools === 'object') {
    toolsList = Object.entries(openaiTools).map(([name, tool]) => ({
      type: 'function',
      function: {
        name,
        description: tool?.description,
        parameters: tool?.inputSchema?.jsonSchema || tool?.inputSchema || tool?.parameters || tool
      }
    }));
  }

  if (toolsList.length === 0) return [];
  
  const declarations = toolsList.map((tool) => {
    const func = tool.function || tool || {};
    return convertSingleTool(
      func.name,
      func.description,
      func.parameters || func.input_schema || func.inputSchema,
      sessionId,
      actualModelName
    );
  });
  
  return [{
    functionDeclarations: declarations
  }];
}

/**
 * 将 Claude 格式的工具列表转换为 Antigravity 格式
 * Claude 格式: [{ name, description, input_schema }]
 * @param {Array} claudeTools - Claude 格式的工具列表
 * @param {string} sessionId - 会话 ID
 * @param {string} actualModelName - 实际模型名称
 * @returns {Array} Antigravity 格式的工具列表（所有工具在一个 functionDeclarations 数组中）
 */
export function convertClaudeToolsToAntigravity(claudeTools, sessionId, actualModelName) {
  if (!claudeTools || claudeTools.length === 0) return [];
  
  const declarations = claudeTools.map((tool) => {
    return convertSingleTool(
      tool.name,
      tool.description,
      tool.input_schema,
      sessionId,
      actualModelName
    );
  });
  
  return [{
    functionDeclarations: declarations
  }];
}

/**
 * 将 Gemini 格式的工具列表转换为 Antigravity 格式
 * Gemini 格式可能是:
 * 1. [{ functionDeclarations: [{ name, description, parameters }] }]
 * 2. [{ name, description, parameters }]
 * @param {Array} geminiTools - Gemini 格式的工具列表
 * @param {string} sessionId - 会话 ID
 * @param {string} actualModelName - 实际模型名称
 * @returns {Array} Antigravity 格式的工具列表（所有工具在一个 functionDeclarations 数组中）
 */
export function convertGeminiToolsToAntigravity(geminiTools, sessionId, actualModelName) {
  if (!geminiTools || geminiTools.length === 0) return [];
  
  const allDeclarations = [];
  for (const tool of geminiTools) {
    // 格式1: 已经是 functionDeclarations 格式（支持驼峰和下划线命名）
    const declarations = tool.functionDeclarations || tool.function_declarations;
    if (declarations) {
      // 收集所有声明
      for (const fd of declarations) {
        allDeclarations.push(
          convertSingleTool(fd.name, fd.description, fd.parameters, sessionId, actualModelName)
        );
      }
    }
    // 格式2: 单个工具定义格式
    else if (tool.name) {
      allDeclarations.push(
        convertSingleTool(
          tool.name,
          tool.description,
          tool.parameters || tool.input_schema,
          sessionId,
          actualModelName
        )
      );
    }
    // 格式3：不处理
  }
  
  return allDeclarations.length > 0 ? [{
    functionDeclarations: allDeclarations
  }] : [];
}
