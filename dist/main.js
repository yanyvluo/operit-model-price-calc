"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerToolPkg = registerToolPkg;

const settings_ui_js_1 = __importDefault(require("./ui/index.ui.js"));
const cost_dialog_ui_js_1 = __importDefault(require("./ui/cost_dialog.ui.js"));
const chat_total_dialog_ui_js_1 = __importDefault(require("./ui/chat_total_dialog.ui.js"));

const PRICE_SETTINGS_ROUTE = "toolpkg:com.yezi.price_calc:ui:price_manager";
const COST_DIALOG_SCREEN = "dist/ui/cost_dialog.ui.js";
const CHAT_TOTAL_DIALOG_SCREEN = "dist/ui/chat_total_dialog.ui.js";

function onMessageMenuItem(event) {
  var payload = (event && event.eventPayload) ? event.eventPayload : {};
  return {
    dialog: {
      state: {
        message: payload.message,
        chatId: payload.chatId,
        messageIndex: payload.messageIndex
      }
    }
  };
}

function onChatTotalMenuItem(event) {
  var payload = (event && event.eventPayload) ? event.eventPayload : {};
  return {
    dialog: {
      state: {
        chatId: payload.chatId
      }
    }
  };
}

function registerToolPkg() {
  if (ToolPkg.registerUiRoute) {
    ToolPkg.registerUiRoute({
      id: "price_manager_route",
      route: PRICE_SETTINGS_ROUTE,
      runtime: "compose_dsl",
      screen: settings_ui_js_1.default,
      params: {},
      keepAlive: false,
      title: {
        zh: "模型价格",
        en: "Model Price"
      }
    });
  }

  if (ToolPkg.registerNavigationEntry) {
    ToolPkg.registerNavigationEntry({
      id: "price_manager_sidebar",
      route: PRICE_SETTINGS_ROUTE,
      surface: "main_sidebar_plugins",
      title: {
        zh: "模型价格",
        en: "Model Price"
      },
      icon: "Calculate",
      order: 151
    });
  }

  ToolPkg.registerToolboxUiModule({
    id: "price_manager_settings",
    runtime: "compose_dsl",
    screen: settings_ui_js_1.default,
    params: {},
    title: {
      zh: "模型价格设置",
      en: "Model Price Settings"
    }
  });

  if (ToolPkg.registerChatMessageMenuItem) {
    ToolPkg.registerChatMessageMenuItem({
      id: "price_calc_message_cost",
      title: {
        zh: "这条花了多少",
        en: "Cost of this message"
      },
      icon: "Calculate",
      order: 30,
      senders: ["ai", "user"],
      dialog: {
        screen: COST_DIALOG_SCREEN,
        title: {
          zh: "本条费用",
          en: "Message Cost"
        }
      },
      function: onMessageMenuItem
    });

    ToolPkg.registerChatMessageMenuItem({
      id: "price_calc_chat_total",
      title: {
        zh: "本对话花了多少",
        en: "Total cost of this chat"
      },
      icon: "Calculate",
      order: 31,
      senders: ["ai", "user"],
      dialog: {
        screen: CHAT_TOTAL_DIALOG_SCREEN,
        title: {
          zh: "本对话费用",
          en: "Chat Total Cost"
        }
      },
      function: onChatTotalMenuItem
    });
  }

  return true;
}

exports.onMessageMenuItem = onMessageMenuItem;
exports.onChatTotalMenuItem = onChatTotalMenuItem;