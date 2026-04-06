const fs = require("fs");
const path = require("path");

// Create logs directory if it doesn't exist
const logDir = path.join(__dirname, "../../logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Simple logger implementation
class Logger {
  constructor() {
    this.logFile = path.join(logDir, "app.log");
    this.level = process.env.LOG_LEVEL || "info";
  }

  formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  }

  log(level, message) {
    const formattedMessage = this.formatMessage(level, message);

    // Console output
    if (level === "error") {
      console.error(formattedMessage);
    } else {
      console.log(formattedMessage);
    }

    // File output
    fs.appendFileSync(this.logFile, formattedMessage);
  }

  info(message) {
    this.log("info", message);
  }

  error(message) {
    this.log("error", message);
  }

  warn(message) {
    this.log("warn", message);
  }

  debug(message) {
    if (this.level === "debug") {
      this.log("debug", message);
    }
  }
}

module.exports = new Logger();
