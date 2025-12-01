# Frankenstein TypeScript WebAssembly Demo

This project demonstrates how to use the Frankenstein engine with TypeScript and compile it to WebAssembly. It provides a basic setup for creating a 3D demo environment using the Frankenstein engine.

## Project Structure

```
frankenstein-ts-wasm-demo
├── src
│   ├── index.ts            # Main entry point for the TypeScript application
│   ├── wasm-loader.ts      # Handles loading the WebAssembly module
│   └── types
│       └── frankenstein.d.ts # Type definitions for the Frankenstein engine
├── assembly
│   ├── index.ts            # Entry point for the AssemblyScript code
│   ├── asconfig.json       # Configuration for AssemblyScript compiler
│   └── package.json        # npm configuration for AssemblyScript
├── public
│   └── index.html          # HTML file for the web application
├── scripts
│   └── build-wasm.sh       # Shell script to build the WebAssembly module
├── package.json            # npm configuration for the TypeScript project
├── tsconfig.json           # TypeScript compiler options
├── webpack.config.js       # Webpack configuration for bundling
├── .gitignore              # Files and directories to ignore in Git
└── README.md               # Project documentation
```

## Setup Instructions

1. **Clone the repository:**
   ```
   git clone <repository-url>
   cd frankenstein-ts-wasm-demo
   ```

2. **Install dependencies:**
   ```
   npm install
   cd assembly
   npm install
   ```

3. **Build the WebAssembly module:**
   ```
   cd ..
   ./scripts/build-wasm.sh
   ```

4. **Run the demo:**
   You can use a local server to serve the `public` directory. For example, you can use `http-server`:
   ```
   npm install -g http-server
   http-server public
   ```

5. **Open your browser:**
   Navigate to `http://localhost:8080` (or the port provided by your server) to see the demo in action.

## Usage

The demo showcases the capabilities of the Frankenstein engine, including rendering 3D entities and handling user interactions. You can modify the source files in the `src` directory to customize the demo or add new features.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request for any enhancements or bug fixes.

## License

This project is licensed under the MIT License. See the LICENSE file for more details.