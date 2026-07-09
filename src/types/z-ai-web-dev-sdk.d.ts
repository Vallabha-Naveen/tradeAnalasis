/**
 * Type declarations for z-ai-web-dev-sdk.
 *
 * The package ships as CommonJS without TypeScript definitions.
 * This is a minimal declaration that covers the VLM (vision) API
 * used by src/analyzer/detectOptionTypeVLM.ts.
 */

declare module 'z-ai-web-dev-sdk' {
  interface VisionMessageContentItem {
    type: 'text' | 'image_url' | 'video_url' | 'file_url';
    text?: string;
    image_url?: { url: string };
    video_url?: { url: string };
    file_url?: { url: string };
  }

  interface VisionMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | VisionMessageContentItem[];
  }

  interface VisionCompletionRequest {
    messages: VisionMessage[];
    thinking?: { type: 'disabled' | 'enabled' };
    /** Model name — required for BigModel public API (e.g. 'glm-4v'). */
    model?: string;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
  }

  interface VisionCompletionResponse {
    choices: Array<{
      message: {
        role: string;
        content: string;
      };
      finish_reason?: string;
      index?: number;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  }

  interface ZaiChatCompletions {
    /**
     * Standard OpenAI-compatible chat/completions endpoint.
     * Works with BOTH text and vision models — just pass `model: 'glm-4v'`
     * and include `image_url` content items in the messages.
     *
     * This is the correct method to use for BigModel's public API.
     */
    create(req: VisionCompletionRequest): Promise<VisionCompletionResponse>;
    /**
     * Z.ai-internal vision endpoint (`/chat/completions/vision`).
     * Does NOT work on BigModel's public API — use `create()` instead.
     * @deprecated
     */
    createVision(req: VisionCompletionRequest): Promise<VisionCompletionResponse>;
  }

  interface ZaiInstance {
    chat: {
      completions: ZaiChatCompletions;
    };
  }

  interface ZaiStatic {
    create(): Promise<ZaiInstance>;
  }

  const ZAI: ZaiStatic;
  export default ZAI;
}
