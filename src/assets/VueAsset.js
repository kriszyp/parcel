const Asset = require('../Asset');
const localRequire = require('../utils/localRequire');
const md5 = require('../utils/md5');

class VueAsset extends Asset {
  constructor(name, pkg, options) {
    super(name, pkg, options);
    this.type = 'js';
  }

  async parse(code) {
    // Is being used in component-compiler-utils, errors if not installed...
    this.vueTemplateCompiler = await localRequire(
      'vue-template-compiler',
      this.name
    );
    this.vue = await localRequire('@vue/component-compiler-utils', this.name);

    return this.vue.parse({
      source: code,
      needMap: this.options.sourceMaps,
      filename: this.relativeName, // Used for sourcemaps
      sourceRoot: '' // Used for sourcemaps. Override so it doesn't use cwd
    });
  }

  async generate() {
    let descriptor = this.ast;
    let parts = [];

    if (descriptor.script) {
      parts.push({
        type: descriptor.script.lang || 'js',
        value: descriptor.script.content,
        sourceMap: descriptor.script.map
      });
    }

    if (descriptor.template) {
      parts.push({
        type: descriptor.template.lang || 'html',
        value: descriptor.template.content.trim()
      });
    }

    if (descriptor.styles) {
      for (let style of descriptor.styles) {
        parts.push({
          type: style.lang || 'css',
          value: style.content.trim(),
          modules: !!style.module
        });
      }
    }

    return parts;
  }

  async postProcess(generated) {
    let result = [];

    let hasScoped = this.ast.styles.some(s => s.scoped);
    let id = md5(this.name).slice(-6);
    let scopeId = hasScoped ? `data-v-${id}` : null;
    let optsVar = '$' + id;

    // Generate JS output.
    let js = this.ast.script ? generated[0].value : '';
    js += `
      var ${optsVar} = exports.default || module.exports;
      if (typeof ${optsVar} === 'function') {
        ${optsVar} = ${optsVar}.options;
      }
    `;

    js += this.compileTemplate(generated, scopeId, optsVar);
    js += this.compileCSSModules(generated, optsVar);
    js += this.compileHMR(generated, optsVar);

    if (js) {
      result.push({
        type: 'js',
        value: js
      });
    }

    // TODO: combine in case of multiple js parts?
    // Unfortunately compileTemplate currently doesn't generate sourcemaps
    let map = generated.find(r => r.type === 'map');
    if (map) {
      result.push(map);
    }

    let css = this.compileStyle(generated, scopeId);
    if (css) {
      result.push({
        type: 'css',
        value: css
      });
    }

    return result;
  }

  compileTemplate(generated, scopeId, optsVar) {
    let html = generated.find(r => r.type === 'html');
    if (html) {
      let template = this.vue.compileTemplate({
        source: html.value,
        filename: this.relativeName,
        compiler: this.vueTemplateCompiler,
        isProduction: this.options.production,
        compilerOptions: {
          scopeId
        }
      });

      if (Array.isArray(template.errors) && template.errors.length >= 1) {
        throw new Error(template.errors[0]);
      }

      return `
        /* template */
        Object.assign(${optsVar}, (function () {
          ${template.code}
          return {
            render: render,
            staticRenderFns: staticRenderFns,
            _compiled: true,
            _scopeId: ${JSON.stringify(scopeId)}
          };
        })());
      `;
    }

    return '';
  }

  compileCSSModules(generated, optsVar) {
    let cssRenditions = generated.filter(r => r.type === 'css');
    let cssModulesCode = '';
    this.ast.styles.forEach((style, index) => {
      if (style.module) {
        let cssModules = JSON.stringify(cssRenditions[index].cssModules);
        let name = style.module === true ? '$style' : style.module;
        cssModulesCode += `\nthis[${JSON.stringify(name)}] = ${cssModules};`;
      }
    });

    if (cssModulesCode) {
      return `
        /* css modules */
        (function () {
          function beforeCreate(){${cssModulesCode}\n}
          ${optsVar}.beforeCreate = ${optsVar}.beforeCreate ? ${optsVar}.beforeCreate.concat(beforeCreate) : [beforeCreate];
        })()
      `;
    }

    return '';
  }

  compileStyle(generated, scopeId) {
    return generated.filter(r => r.type === 'css').reduce((p, r, i) => {
      let css = r.value;
      let scoped = this.ast.styles[i].scoped;

      // Process scoped styles if needed.
      if (scoped) {
        let {code, errors} = this.vue.compileStyle({
          source: css,
          filename: this.relativeName,
          id: scopeId,
          scoped
        });

        if (errors.length) {
          throw errors[0];
        }

        css = code;
      }

      return p + css;
    }, '');
  }

  compileHMR(generated, optsVar) {
    if (!this.options.hmr) {
      return '';
    }

    this.addDependency('vue-hot-reload-api');
    this.addDependency('vue');

    let cssHMR = '';
    if (this.ast.styles.length) {
      cssHMR = `
        var reloadCSS = require('_css_loader');
        module.hot.dispose(reloadCSS);
        module.hot.accept(reloadCSS);
      `;
    }

    return `
    /* hot reload */
    (function () {
      if (module.hot) {
        var api = require('vue-hot-reload-api');
        api.install(require('vue'));
        if (api.compatible) {
          module.hot.accept();
          if (!module.hot.data) {
            api.createRecord('${optsVar}', ${optsVar});
          } else {
            api.reload('${optsVar}', ${optsVar});
          }
        }

        ${cssHMR}
      }
    })()`;
  }
}

module.exports = VueAsset;
