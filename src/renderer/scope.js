var utils = require('./../utils.js');
var common = require('./common.js');
var builders = require('./builders.js');
var events = require('./events.js');

var scope = {
    // Init VMs for components and repeat items
    initViewModel: function (contexts) {
        var options = {};
        var data = {};
        var vm;

        if (contexts.isComponent) {
            utils.extend(options, new contexts.component());

        // Inherit data to v-repeat items contexts
        } else if (contexts.isRepeat) {
            utils.each(contexts.parent, function (item, key) {
                if (!scope.isSystemProp(key, contexts.parent) && !data[key]) {
                    data[key] = item;
                }
            });
        }

        // Inherit parent data
        if (contexts.parent && options.inherit) {
            scope.inheritData(data, contexts.parent);
        }

        // Init context
        vm = utils.extend(data, this.globalPrototype);
        scope.initPrivateState(vm, {
            parent: contexts.parent
        });

        if (contexts.isRepeat) {
            vm.__states.isRepeat = true;
        }

        if (contexts.isComponent) {
            vm.__states.isComponent = true;
        }

        vm.$options = options;

        if (this.config.strict) {
            vm.$options.filters = utils.extend({}, this.filters, vm.$options.filters);
            vm.$options.partials = utils.extend({}, this.partials, vm.$options.partials);
            vm.$options.components = utils.extend({}, this.components, vm.$options.components);
        } else {
            vm.$options.filters = utils.extend(
                {}, this.filters, contexts.filters, vm.$options.filters
            );
            vm.$options.partials = utils.extend(
                {}, this.partials, contexts.partials, vm.$options.partials
            );
            vm.$options.components = utils.extend(
                {}, this.components, contexts.components, vm.$options.components
            );
        }

        // Special alias for recursive component invocation
        if (vm.$options.name && contexts.componentName) {
            vm.$options.components[vm.$options.name] = contexts.components[contexts.componentName];
        }

        vm.__states.$logger = this.$logger;

        this.setRefsAndEls(vm);
        vm.$el = contexts.element;
        vm.$data = data;
        vm.$parent = contexts.parentLink ? contexts.parentLink : contexts.parent;
        vm.$root = contexts.parent ? contexts.parent.$root : vm;

        // events bookkeeping
        vm._events = {};
        vm._eventsCount = {};
        vm._eventCancelled = false;

        vm.$children = [];
        vm._isCompiled = false;
        vm._isReady = false;
        vm.isServer = true;

        scope.initVmSystemMethods(vm);

        // Init ONLY for components
        if (vm.__states.isComponent) {
            var tpl = scope.initTemplate(vm);

            // That shoild be $root VM
            if (!vm.__states.parent) {
                if (!tpl) {
                    vm.__states.$logger.error('There is no $root template. Can\'t start rendering');
                }
                vm.__states.notReadyCount = 0;
                vm.__states.toRebuild = false;
                vm.__states.mixin = this.mixin;
            }

            scope.setKeyElementInner(vm, tpl);

            utils.extend(vm, vm.$options.methods);

            scope.setEventListeners(vm);
        }

        scope.markKeyElement(vm);

        // Init VM data from 'data' option
        scope.initData(vm);

        // Pull props data
        scope.pullPropsData(vm);

        if (contexts.repeatData) {
            utils.extend(vm, contexts.repeatData);
        }

        // Events option binded event handlers
        if (vm.$options.events) {
            for (var name in vm.$options.events) {
                vm.$on(name, utils.bind(vm.$options.events[name], vm));
            }
        }

        var createdHookFired = false;
        // Building computed properties for the first time
        scope.buildComputedProps(vm);

        // Server Created mixins
        scope.callHookMixin(vm, 'createdBe', function () {
            createdHookFired = true;
        });

        // Server Created hook
        scope.callHook(vm, 'createdBe');

        scope.buildWithedData(vm, contexts);
        if (createdHookFired) {
            // Building computed properties for the second time
            // If there was a possibility the data was modifed by hooks
            scope.buildComputedProps(vm);
        }

        scope.updateNotReadyCount(vm, +1);
        builders.build(vm, function () {
            vm._isCompiled = true;
            var isToRebuild = false;
            var isRepeatInstance = false;
            if (
                vm.__states.isRepeat ||
                (vm.__states.parent && vm.__states.parent.__states.notPublic)
            ) {
                isRepeatInstance = true;
            }

            if (!isRepeatInstance && !vm.$options.activateBe && contexts.waitFor) {
                vm.$on(contexts.waitFor, function () {
                    vm.$root.__states.toRebuild = true;
                    scope.updateNotReadyCount(vm, -1);
                });
            }

            // Server Compiled mixins
            scope.callHookMixin(vm, 'compiledBe', function () {
                isToRebuild = true;
            });

            // Data could be changed inside the hook
            // if so we should rebuild the instance
            scope.callHook(vm, 'compiledBe', function () {
                isToRebuild = true;
            });

            if (!isRepeatInstance) {
                // If the hook is present it will be rebuilded automatically
                // no need turn on 'isToRebuild'
                scope.callHook(vm, 'activateBe');

                if (contexts.waitFor || vm.$options.activateBe) {
                    return;
                }
            } else if (vm.$options.activateBe) {
                vm.__states.$logger.warn(
                    'activateBe can\'t be fired on "v-for"-ed or "v-repeat"-ed instances',
                    common.onLogMessage(vm)
                );
            }

            if (isToRebuild && vm !== vm.$root) {
                scope.resetVmInstance(vm);
                scope.updateNotReadyCount(vm, -1);
                return;
            }

            vm._isReady = true;
            scope.updateNotReadyCount(vm, -1);
        });

        return vm;
    },

    initVmSystemMethods: function (vm) {
        // Setting event control methods
        utils.extend(vm, events);

        vm.$set = function (keypath, value) {
            utils.set(this, keypath, value);
            return this;
        };

        vm.$get = function (keypath, mode) {
            var result = utils.get(this, keypath);
            return result;
        };

        vm.$addChild = function (options) {
            var newVm;
            var presentVm;
            var $target = scope.getRealParent(vm);

            if (this.__states.VMsDetached && options.component && !options.repeatData) {
                presentVm = this.__states.VMsDetached[options.element.id + options.componentName];
                this.__states.VMsDetached[options.element.id + options.componentName] = undefined;
            }

            if (!presentVm) {
                newVm = scope.initViewModel(
                    utils.extend({
                        parent: this,
                        parentLink: $target,
                        filters: $target.$options.filters,
                        partials: $target.$options.partials,
                        components: $target.$options.components
                    }, options)
                );
            } else {
                scope.resetVmInstance(presentVm, options.element);
                scope.buildWithedData(presentVm, options);
                scope.pullPropsData(presentVm);
                newVm = presentVm;
            }

            // Needed for async component support
            // Async component is not created immediately
            if (options.childIndex !== undefined) {
                this.__states.children[options.childIndex] = newVm;
            } else {
                this.__states.children.push(newVm);
            }

            // VMs from v-for no need to add in $children
            $target.$children.push(newVm);

            if (options.element.dirs.ref) {
                (function () {
                    var name = common.dashToCamelCase(options.element.dirs.ref.value);

                    if (newVm.__states.isRepeat || newVm.__states.parent.__states.notPublic) {
                        $target.$refs[name] = $target.$refs[name] || [];
                        $target.$refs[name].push(newVm);
                    } else {
                        $target.$refs[name] = newVm;
                    }

                })();
            }

            if (!this.__states.notPublic && options.component && !options.repeatData) {
                this.__states.VMs = this.__states.VMs || {};
                this.__states.VMs[options.element.id + options.componentName] = newVm;
            }
        };

        vm.$addLightChild = function (options) {
            var newVm = scope.initLightViewModel(
                utils.extend({
                    parent: this,
                    filters: this.$options.filters
                }, options)
            );

            // Needed for async component support
            // Async component is not created immediately
            if (options.childIndex !== undefined) {
                this.__states.children[options.childIndex] = newVm;
            } else {
                this.__states.children.push(newVm);
            }
        };

        vm.$nextTick = function (cb) {
            var self = this;
            process.nextTick(function () {
                cb.call(self);
            });
        };

        vm.$log = function (name) {
            this.$logger.log(this[name], common.onLogMessage(this));
        };
    },

    resetVmInstance: function (vm, newEl) {
        this.setRefsAndEls(vm);
        if (newEl) {
            vm.$el = newEl;
            scope.markKeyElement(vm);
        }
        vm.$children = [];
        vm.__states.children = [];
        vm.__states.childrenReadyCount = 0;
        vm.__states.VMsDetached = vm.__states.VMs;
        vm.__states.VMs = {};
        vm._isReady = false;
        // var tpl = scope.initTemplate(vm);

        if (vm.$el.builded) {
            scope.setKeyElementInner(vm, vm.$el.builded.inner);
        }

        // Should not reset $root VM events
        if (vm.__states.parent) {
            vm._events = {};
            vm._eventsCount = {};
            vm._eventCancelled = false;
            scope.setEventListeners(vm);
        }
        scope.buildComputedProps(vm);
        scope.updateNotReadyCount(vm, +1);
        builders.build(vm, function () {
            vm._isReady = true;
            scope.updateNotReadyCount(vm, -1);
        });
    },

    setKeyElementInner: function (vm, tpl) {
        // If there is no parent, then we have root component
        // Creating special container for root component
        if (!vm.__states.parent) {
            vm.$el = {
                type: 'document',
                attribs: {},
                dirs: {},
                inner: tpl || []
            };
            return;
        }

        var shouldReplace = this.config.replace;

        if (vm.$options.replace !== undefined) {
            shouldReplace = vm.$options.replace;
        }

        vm.$el.original = {
            name: vm.$el.name,
            inner: vm.$el.inner
        };

        if (tpl) {
            // Element merge mode
            if (shouldReplace) {
                // If there is only one top level element
                if (!tpl[1]) {
                    vm.$el.name = '$merge';

                // If there are many top level elements
                } else {
                    vm.$el.name = 'template';
                }
            }
            vm.$el.inner = tpl;
        } else {
            vm.$el.name = 'template';
            vm.$el._componentEmptyTpl = true;
        }
    },

    saveInnerTemplate: function (vm, tpl) {
        if (vm.$el.inner && vm.$el.inner.length) {
            vm.$el.innerOutside = vm.$el.inner;
        }
    },

    setEventListeners: function (vm) {
        vm.$on('vueServer:action.rebuildComputed', function () {
            scope.buildComputedProps(vm);
        });

        vm.$on('_vueServer.stopBuilding', function () {
            vm.$el.__buildingInterrupted = true;
        });

        vm.$on('_vueServer.readyToCompile', function () {
            // Server Ready mixins
            scope.callHookMixin(vm, 'readyBe');

            // Server Ready hook
            scope.callHook(vm, 'readyBe');
        });

        // Cross-VM events defined inside templates
        if (vm.$el.dirs.on) {
            for (var eventName in vm.$el.dirs.on) {
                scope.setTemplateEventHandler(vm, vm.$el.dirs.on[eventName], eventName);
            }
        }
    },

    setTemplateEventHandler: function (vm, directive, eventName) {
        // Converting hooks names
        // for example: "hook:created-be" -> "hook:createdBe"
        eventName = eventName.replace(/^(hook:)(.+)/, function (a, b, c) {
            return b + common.dashToCamelCase(c);
        });

        if (directive.value.hasArgs) {
            vm.$on(
                eventName,
                function () {
                    directive.value.handler.call(vm.$parent, vm.$parent);
                }
            );
        } else {
            vm.$on(
                eventName,
                function () {
                    var result = common.getValue(vm.$parent, directive.value.handler);
                    if (typeof result === 'function') {
                        result.apply(vm.$parent, arguments);
                    }
                }
            );
        }
    },

    buildWithedData: function (vm, contexts) {
        var withReplaceData;
        var name;
        var value;
        // Replace data context by w-with "flat" inheritance
        if (contexts.withReplaceData) {
            vm.__states.hasWithData = true;
            for (var key in vm) {
                if (scope.isSystemProp(key) || vm.$options.methods[key]) {
                    continue;
                }

                delete vm[key];
            }
            withReplaceData = common.getValue(vm.__states.parent, contexts.withReplaceData);
            utils.extend(vm, withReplaceData);
        }

        if (contexts.withData) {
            vm.__states.hasWithData = true;
            for (var i = 0, l = contexts.withData.length; i < l; i++) {
                item = contexts.withData[i];
                vm[item.arg] = common.getValue(vm.__states.parent, item.get);
            }
        }
    },

    isSystemProp: function (name, $parent) {
        if ($parent && $parent.$options.methods && $parent.$options.methods[name]) {
            return false;
        }

        var char = name.charAt(0);
        if (char === '$' || char === '_') {
            return true;
        }

        return false;
    },

    markKeyElement: function (vm) {
        // Mark the key element for VM
        vm.$el._isKeyElement = true;
        if (vm.__states.isComponent && !vm.__states.isRepeat) {
            vm.$el._compileSelfInParentVm = true;
        }
    },

    // Set data context and validate data
    initData: function (vm) {
        var ownData = scope.initDataUnit(vm, vm.$options.data);
        var mixinResults;
        var result;

        if (vm.$options.mixins) {
            mixinResults = [];
            for (var i = vm.$options.mixins.length - 1; i >= 0; i--) {
                if (vm.$options.mixins[i].data) {
                    mixinResults.push(scope.initDataUnit(vm, vm.$options.mixins[i].data));
                }
            }

            mixinResults = mixinResults.reverse();
            mixinResults.push(ownData);
            result = utils.extend.apply(common, mixinResults);
        } else {
            result = ownData;
        }

        utils.extend(vm, result);
    },

    initDataUnit: function (vm, data) {
        var result = {};
        if (data) {
            var dataType = typeof data;
            if (
                dataType === 'object' &&
                !vm.__states.parent &&
                data instanceof Array !== true
            ) {
                return data;
            }

            if (dataType === 'function') {
                result = data.call(vm) || {};
            } else {
                vm.__states.$logger.warn('The "data" option type is not valid', common.onLogMessage(vm));
            }
        }
        return result;
    },

    initTemplate: function (vm) {
        if (vm.$options.template) {
            return vm.$options.template();
        } else {
            return null;
        }
    },

    // Compute "computed" props
    buildComputedProps: function (vm) {
        if (vm.$options.computed) {
            var item;
            for (var name in vm.$options.computed) {
                item = vm.$options.computed[name];

                if (typeof item === 'function') {
                    try {
                        vm[name] = item.call(vm);
                    } catch (error) {
                        vm.__states.$logger.debug(
                            'Computed property "' + name + '" compilation error',
                            common.onLogMessage(vm), '\n',
                            error
                        );
                    }
                } else {
                    try {
                        vm[name] = item.get.call(vm);
                    } catch (error) {
                        vm.__states.$logger.debug(
                            'Computed property "' + name + '" compilation error',
                            common.onLogMessage(vm), '\n',
                            error
                        );
                    }
                }
            }
        }

        return this;
    },

    pullPropsData: function (vm) {
        var props = vm.$options.props;
        if (props) {
            vm.__states.hasProps = true;
            utils.each(props, function (item, name) {
                scope.pullPropsDataItem(vm, name, item);
            });
        }
    },

    pullPropsDataItem: function (vm, name, config) {
        var attrName = common.camelToDashCase(name);
        var propName = common.dashToCamelCase(name);
        var descriptor;

        // It is to point to the entrance of the component content
        // not to prematurely remove the attributes required for props
        vm.$el.props = vm.$el.props || {};
        if (vm.$el.attribs[attrName] !== undefined) {
            vm.$el.props[attrName] = vm.$el.attribs[attrName];
            vm.$el.attribs[attrName] = undefined;
        }

        // If props is Object
        if (config !== undefined) {
            descriptor = {
                type: null,
                default: null,
                required: false,
                validator: null
            };

            if (config === null || config.constructor && config.name) {
                descriptor.type = config;
            } else {
                utils.extend(descriptor, config);
            }
        }

        // v-for context
        // var parentScope = vm.__states.vForScope ? vm.__states.vForScope: vm.$parent;

        var value;

        var rawValue = vm.$el.props[attrName];

        // Implementation of setting props by v-bind
        if (vm.$el.dirs.bind && vm.$el.dirs.bind[attrName]) {
            rawValue = {
                value: vm.$el.dirs.bind[attrName].value.get,
                filters: vm.$el.dirs.bind[attrName].value.filters
            };
            vm.$el.dirs.bind[attrName].isCompiled = true;
        }

        if (rawValue) {
            value = common.execute(vm.__states.parent, rawValue, {
                isEscape: false,
                isClean: false
            });
        }

        var mirroredValue = vm.__states.initialDataMirror[propName];
        if (mirroredValue !== undefined && vm.__states.initialDataMirror[propName] === value) {
            return;
        } else {
            // if (!vm.__states.indepent) {
            //     typeof
            // }
            vm.__states.initialDataMirror[propName] = value;
        }

        if (descriptor) {
            if (!rawValue) {
                // Default value
                if (typeof descriptor.default === 'function') {
                    value = descriptor.default();
                } else {
                    value = descriptor.default;
                }

                // Required field
                if (descriptor.required) {
                    vm.__states.$logger.warn(
                        'Missing required prop: ' + propName, common.onLogMessage(vm)
                    );
                    return;
                }
            } else {
                // Data types
                if (descriptor.type) {
                    var hasTypeError = false;
                    var type;

                    if (value === null || value === undefined) {
                        hasTypeError = true;
                        type = value;
                    } else if (value.constructor !== descriptor.type) {
                        hasTypeError = true;
                        type = value.constructor.name;
                    }

                    if (hasTypeError) {
                        vm.__states.$logger.warn(
                            'Invalid prop: type check failed for "' + propName + '". Expected ' +
                                descriptor.type.name + ', got ' + type,
                            common.onLogMessage(vm)
                        );
                        return;
                    }
                }

                // Data validation
                if (rawValue && descriptor.validator && !descriptor.validator(value)) {
                    vm.__states.$logger.warn('Invalid prop: custom validator check failed for "' + propName +
                        '"', common.onLogMessage(vm));
                    return;
                }
            }
        }

        // Callback inheritance from parent
        if (typeof value === 'function') {
            value = utils.bind(value, vm.__states.parent);
        }

        vm[propName] = value;
    },

    inheritData: function (dataTo, dataFrom) {
        for (var key in dataFrom) {
            if (scope.isSystemProp(key) || dataTo[key] || dataFrom.$options.methods[key]) {
                continue;
            }
            dataTo[key] = dataFrom[key];
        }

        return dataTo;
    },

    // Init VMs for v-for
    initLightViewModel: function (contexts) {
        var options = {};
        var vm = utils.extend({}, this.globalPrototype);

        utils.each(contexts.parent, function (item, key) {
            if (!scope.isSystemProp(key, contexts.parent) && !vm[key]) {
                vm[key] = item;
            }
        });

        scope.initPrivateState(vm, {
            parent: contexts.parent,
            notPublic: true
        });

        if (this.config.strict) {
            options.filters = utils.extend({}, this.filters, options.filters);
        } else {
            options.filters = utils.extend({}, this.filters, contexts.filters, options.filters);
        }

        vm.__states.$logger = this.$logger;

        this.setRefsAndEls(vm);
        vm.$el = contexts.element;
        vm.$options = options;
        vm.$parent = contexts.parentLink ? contexts.parentLink : contexts.parent;
        vm.$root = contexts.parent.$root;

        // events bookkeeping
        vm._events = {};
        vm._eventsCount = {};
        vm._eventCancelled = false;

        vm._isCompiled = false;
        vm._isReady = false;
        vm.isServer = true;

        scope.initVmSystemMethods(vm);

        scope.markKeyElement(vm);

        if (contexts.repeatData) {
            utils.extend(vm, contexts.repeatData);
        }

        scope.updateNotReadyCount(vm, +1);
        builders.build(vm, function () {
            vm._isReady = true;
            scope.updateNotReadyCount(vm, -1);
        });

        return vm;
    },

    getRealParent: function (vm) {
        if (vm.__states.notPublic) {
            return this.getRealParent(vm.__states.parent);
        }

        return vm;
    },

    setRefsAndEls: function (vm) {
        vm.$refs = {};
        vm.$els = {};
        vm.$ = vm.$refs;
        vm.$$ = vm.$els;
    },

    updateNotReadyCount: function (vm, change) {
        vm.$root.__states.notReadyCount += change;

        if (vm.$root.__states.notReadyCount === 0) {
            if (vm.$root.__states.toRebuild) {
                scope.resetVmInstance(vm.$root);
                vm.$root.__states.toRebuild = false;
            } else {
                vm.$root.$emit('_vueServer.tryBeginCompile');
            }
        }

        if (vm.$root.__states.notReadyCount < 0) {
            vm.$root.__states.$logger.warn(
                'Deviance in VMs ready check detected', common.onLogMessage(vm.$root)
            );
        }
    },

    initPrivateState: function (vm, extra) {
        vm.__states = utils.extend({
            children: [],
            childrenReadyCount: 0,
            initialDataMirror: {},
            hasProps: false,
            hasWithData: false
        }, extra);
    },

    callHook: function (vm, name, callback) {
        var isPresent = false;
        var hook = vm.$options[name];

        if (hook) {
            isPresent = true;
            if (name === 'activateBe') {
                // "done" callback
                hook.call(vm, function () {
                    vm.$root.__states.toRebuild = true;
                    scope.updateNotReadyCount(vm, -1);
                });
            } else {
                hook.call(vm);
            }
        }

        vm.$emit('hook:' + name);

        if (isPresent && callback) {
            callback();
        }

        return isPresent;
    },

    /**
     * Running a hook's of mixins
     */
    callHookMixin: function (vm, name, callback) {
        if (vm.$options.mixins) {
            for (var i = 0; i < vm.$options.mixins.length; i++) {
                if (vm.$options.mixins[i][name]) {
                    vm.$options.mixins[i][name].call(vm);
                    if (callback) {
                        callback();
                    }
                }
            }
        }
    }
};

module.exports = scope;
