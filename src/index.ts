import { Compiler } from 'webpack';
import { Source } from 'webpack-sources';

import Debug = require('debug');
import { expect } from '@glimmer/util';
import { AppCompilerDelegate, MUCompilerDelegate, Builtins } from '@glimmer/compiler-delegates';

import Bundle, { Specifiers } from './bundle';
import Scope from './scope';
import { AST } from '@glimmer/syntax';

const debug = Debug('glimmer-compiler-webpack-plugin:plugin');

let loaderOptions: any[] = [];

interface Constructor<T> {
  new (...args: any[]): T;
}

type Mode = 'basic' | 'module-unification';

interface PluginOptions<TemplateMeta> {
  output: string;
  context?: string;
  mode?: Mode;
  helpers?: Specifiers<TemplateMeta>;
  CompilerDelegate?: Constructor<AppCompilerDelegate<{}>>;
  builtins?: Builtins;
  mainPath?: string;
}

interface Module {
  __table: Source;
  _source: Source;
  parser: any;
  resource: string;
  reasons: any[];
}

interface Callback {
  (err?: Error): void;
}

class GlimmerCompiler {
  static component() { return loader('./loaders/component'); }
  static template() { return loader('./loaders/template'); }
  static ast() { return loader('./loaders/ast'); }
  static data() { return loader('./loaders/data'); }

  component() { return instanceLoader('./loaders/component', this); }
  template() { return instanceLoader('./loaders/template', this); }
  ast() { return instanceLoader('./loaders/ast', this); }
  data() { return instanceLoader('./loaders/data', this); }

  bundle: Bundle<{}>;
  options: PluginOptions<{}>;

  protected outputFile: string;

  protected CompilerDelegate: Constructor<AppCompilerDelegate<{}>> | null;
  protected mode: Mode | null;

  /**
   * Webpack `Module` instances pushed in by the data loader. At compile time,
   * these are populated by the generated Glimmer data segment.
   */
  protected dataSegmentModules: Module[] = [];
  protected loaderOptions: any[];

  constructor(options: PluginOptions<{}>) {
    this.options = options;
    this.outputFile = this.options.output;

    if (options.mode && options.CompilerDelegate) {
      throw new Error(`You can provide a mode or a compiler delegate, but not both.`);
    }

    this.CompilerDelegate = options.CompilerDelegate || null;

    for (let opts of loaderOptions) {
      opts.compiler = this;
    }

    this.loaderOptions = loaderOptions;

    loaderOptions = [];
  }

  /**
   * Used by the data loader when it discovers a module that should be populated
   * with the compiled data segment.
   */
  addDataSegmentModule(module: Module) {
    this.dataSegmentModules.push(module);
  }

  /**
   * Used by the component loader when it discovers a module that contains a
   * component template.
   */
  addComponent(path: string, template: string, scope: Scope) {
    this.bundle.add(path, template, scope);
  }

  addAST(path: string, ast: AST.Program) {
    this.bundle.addAST(path, ast);
  }

  apply(compiler: Compiler) {
    debug('applying plugin');
    let inputPath = expect(this.options.context || compiler.options.context, 'expected compiler to have a context');

    compiler.plugin('this-compilation', (compilation: any) => {
      debug('beginning compilation');

      // At the start of a compilation, reset bundle state so we can create
      // a new bundle.
      let dataSegmentModules = this.dataSegmentModules = [];
      this.bundle = this.getBundleFor(inputPath);

      // We mutate the source code of the data segment module during the
      // optimize-tree phase, which requires us to reseal the compilation in
      // order to produce working output. This flag tracks whether the second
      // seal has happened, so we don't end up in an infinite loop requesting
      // reseals.
      let resealed = false;

      compilation.plugin('optimize-tree', (_chunks: any[], _modules: Module[], cb: Callback) => {
        debug('optimizing tree');

        if (resealed) {
          debug('skipping second compile');
          return cb();
        }

        let { bytecode, data } = this.bundle.compile();

        rewriteDataSegmentModules(dataSegmentModules, compilation, data)
          .then(cb, cb);

        compilation.plugin('additional-assets', (cb: () => void) => {
          debug('adding additional assets');
          let { output } = this.options;

          compilation.assets[output] = bytecode;
          cb();
        });

        compilation.plugin('need-additional-seal', () => {
          if (resealed) {
            return false;
          }

          debug('requesting additional seal');
          resetCompilation(compilation);

          return resealed = true;
        });
      })
    });
  }

  protected getBundleFor(inputPath: string) {
    let delegate = this.getCompilerDelegateFor(inputPath);

    return new Bundle({
      inputPath,
      delegate,
      mainPath: this.options.mainPath
    });
  }

  protected getCompilerDelegateFor(inputPath: string) {
    let { mode, CompilerDelegate } = this.options;

    if (!CompilerDelegate) {
      switch (mode) {
        case 'module-unification':
          CompilerDelegate = MUCompilerDelegate;
          break;
        default:
          throw new Error(`Unrecognized compiler mode ${mode}`);
      }
    }

    let locator;
    if (this.options.mainPath) {
      let { mainPath } = this.options;
      locator = { module: mainPath, name: 'default' }
    }

    return new CompilerDelegate!({
      projectPath: inputPath,
      outputFiles: {
        dataSegment: 'table.js',
        heapFile: 'templates.gbx'
      },
      builtins: this.options.builtins,
      mainTemplateLocator: locator
    });
  }
}

function resetCompilation(compilation: any) {
  for (let mod of compilation.modules) {
    mod.used = null;
    mod.usedExports = null;
  }

  compilation.finish();
}

function rewriteDataSegmentModules(modules: Module[], compilation: any, source: Source) {
  let promises = modules.map(m => populateDataSegment(m, compilation, source));

  return Promise.all(promises)
    .then(() => undefined);
}

// Replaces the passed module's source code with the data segment we code
// generate.
function populateDataSegment(module: any, compilation: any, source: Source): Promise<void> {
  module.__table = source;
  return rebuildModule(module, compilation)
}

function rebuildModule(module: any, compilation: any): Promise<void> {
  return new Promise((resolve, reject) => {
    debug('rebuilding module; module=%s', module);

    compilation.rebuildModule(module, (err: any) => {
      if (err) {
        debug('error rebuilding module; module=%s; err=%o', module, err);
        reject(err);
      } else {
        debug('rebuilt module; module=%s', module);
        resolve();
      }
    });
  });
}

function loader(loaderPath: string) {
  debug('generating loader', loaderPath);

  let options = {};
  loaderOptions.push(options);

  return {
    loader: require.resolve(loaderPath),
    options
  }
}

function instanceLoader(loaderPath: string, compiler: any) {
  debug('generating instance loader', loaderPath);

  let options = { compiler };
  compiler.loaderOptions.push(options);

  return {
    loader: require.resolve(loaderPath),
    options
  }
}

export = GlimmerCompiler;
