const _ = require("the-lodash");
const fs = require("fs");
const path = require("path");
const Scope = require("./scope");

class LogicProcessor 
{
    constructor(context)
    {
        this._context = context;
        this._logger = context.logger.sublogger("LogicProcessor");

        this._parsers = [];
        this._extractParsers();

        this._polishers = [];
        this._extractPolishers();
    }

    get logger() {
        return this._logger;
    }

    _extractParsers()
    {
        this.logger.info('[_extractParsers] ...');
        var files = fs.readdirSync(path.join(__dirname, "parsers"));
        files = _.filter(files, x => x.endsWith('.js'));
        for(var x of files)
        {
            this.logger.info('[_extractParsers] %s', x);
            this._loadParser(x);
        }

        this._parsers = _.orderBy(this._parsers, [
            x => x.order,
            x => _.stableStringify(x.target)
        ]);

        for(var handlerInfo of this._parsers)
        {
            this._logger.info("[_extractParsers] HANDLER: %s -> %s, target:", 
                handlerInfo.order, 
                handlerInfo.name, 
                handlerInfo.target)
        }
    }

    _loadParser(name)
    {
        this.logger.info('[_loadParser] %s...', name);
        const handler = require('./parsers/' + name);

        var targets = null;
        if (handler.target) {
            targets = [handler.target];
        } else if (handler.targets) {
            targets = handler.targets;
        }

        var order = 0;
        if (handler.order) {
            order = handler.order;
        }

        for(var target of targets)
        {
            this.logger.info('[_loadParser] Adding %s...', name, target);

            var info = {
                name: name,
                kind: handler.kind,
                order: order,
                target: target,
                handler: handler.handler
            }
            this._parsers.push(info);
        }
    }

    _extractPolishers()
    {
        this.logger.info('[_extractPolishers] ...');
        var files = fs.readdirSync(path.join(__dirname, "polishers"));
        files = _.filter(files, x => x.endsWith('.js'));
        for(var x of files)
        {
            this.logger.info('[_extractPolishers] %s', x);
            this._loadPolisher(x);
        }

        this._parsers = _.orderBy(this._parsers, [
            x => x.order,
            x => _.stableStringify(x.target)
        ]);

        for(var handlerInfo of this._parsers)
        {
            this._logger.info("[_extractPolishers] HANDLER: %s -> %s, target:", 
                handlerInfo.order, 
                handlerInfo.name, 
                handlerInfo.target)
        }
    }

    _loadPolisher(name)
    {
        this.logger.info('[_loadPolisher] %s...', name);
        const handler = require('./polishers/' + name);

        var targets = null;
        if (handler.target) {
            targets = [handler.target];
        } else if (handler.targets) {
            targets = handler.targets;
        }

        var order = 0;
        if (handler.order) {
            order = handler.order;
        }

        for(var target of targets)
        {
            this.logger.info('[_loadPolisher] Adding %s...', name, target);

            var info = {
                name: name,
                kind: handler.kind,
                order: order,
                target: target,
                handler: handler.handler
            }
            this._polishers.push(info);
        }
    }

    process()
    {
        this._logger.info("[process] BEGIN");

        var scope = new Scope(this._context);

        this._processParsers(scope);
        this._processPolishers(scope);
        this._propagete(scope);

        this._logger.info("[process] READY");

        this._context.facadeRegistry.acceptItems(scope.extractItems());
        this._context.facadeRegistry.updateLogicTree(scope.root.exportTree());
        this._context.facadeRegistry.updateConfigTree(scope.configMap);

        this._logger.info("[process] END");

        return this._dumpToFile(scope);
    }

    _processParsers(scope)
    {
        for(var handlerInfo of this._parsers)
        {
            this._processParser(scope, handlerInfo);
        }
    }

    _processParser(scope, handlerInfo)
    {
        this._logger.debug("[_processParser] Handler: %s -> %s, target:", 
            handlerInfo.order, 
            handlerInfo.name, 
            handlerInfo.target);

        var items = this._context.concreteRegistry.filterItems(handlerInfo.target);
        for(var item of items)
        {
            this._processHandler(scope, handlerInfo, item.id, item);
        }
    }

    _processHandler(scope, handlerInfo, id, item)
    {
        this._logger.silly("[_processHandler] Handler: %s, Item: %s", 
            handlerInfo.name, 
            id);

        var handlerArgs = {
            scope: scope,
            logger: this.logger,
            item: item,
            context: this._context,

            createdItems: [],
            createdAlerts: []
        }

        handlerArgs.hasCreatedItems = () => {
            return handlerArgs.createdItems.length > 0;
        }

        handlerArgs.createItem = (parent, name, params) => {
            if (!handlerInfo.kind) {
                throw new Error("Missing handler kind.")
            }
            params = params || {};
            var newObj = parent.fetchByNaming(handlerInfo.kind, name);
            if (params.order) {
                newObj.order = params.order;
            }
            handlerArgs.createdItems.push(newObj);
            return newObj;
        }

        handlerArgs.createK8sItem = (parent, params) => {
            params = params || {};
            var name = params.name || item.config.metadata.name;
            var newObj = handlerArgs.createItem(parent, name, params);
            scope.setK8sConfig(newObj, item.config);
            return newObj;
        }

        handlerArgs.createAlert = (kind, severity, date, msg) => {
            handlerArgs.createdAlerts.push({
                kind,
                severity,
                date,
                msg
            });
        }

        handlerInfo.handler(handlerArgs);

        for(var alertInfo of handlerArgs.createdAlerts)
        {
            for(var createdItem of handlerArgs.createdItems)
            {
                createdItem.addAlert(
                    alertInfo.kind, 
                    alertInfo.severity, 
                    alertInfo.date, 
                    alertInfo.msg);
            }
        }
    }

    _processPolishers(scope)
    {
        for(var handlerInfo of this._polishers)
        {
            this._processPolisher(scope, handlerInfo);
        }
    }

    _processPolisher(scope, handlerInfo)
    {
        this._logger.silly("[_processPolisher] Handler: %s -> %s, target:", 
            handlerInfo.order, 
            handlerInfo.name, 
            handlerInfo.target);

        var path = _.clone(handlerInfo.target.path);
        this._visitTree(scope.root, 0, path, item => {
            this._logger.silly("[_processPolisher] Visited: %s", item.dn);
            this._processHandler(scope, handlerInfo, item.dn, item);
        });
    }

    _visitTree(item, index, path, cb)
    {
        this._logger.silly("[_visitTree] %s, path: %s...", item.dn, path);

        if (index >= path.length)
        {
            cb(item);
        }
        else
        {
            var top = path[index];
            var children = item.getChildrenByKind(top);
            for(var child of children)
            {
                this._visitTree(child, index + 1, path, cb);
            }
        }
    }

    _propagete(scope)
    {
        this._traverseTreeBottomsUp(scope, this._propagateFlags.bind(this));
    }

    _propagateFlags(node)
    {
        this.logger.silly("[_propagateFlags] %s...", node.dn)

        if (node.hasFlag('radioactive')) 
        {
            if (node.parent) 
            {
                node.parent.setFlag('radioactive');
            }
        }
    }

    _traverseTree(scope, cb)
    {
        var col = [scope.root];
        while (col.length)
        {
            var node = col.shift();
            cb(node);
            col.unshift(...node.getChildren());
        }
    }

    _traverseTreeBottomsUp(scope, cb)
    {
        var col = [];
        this._traverseTree(scope, x => {
            col.push(x);
        })

        for(var i = col.length - 1; i >= 0; i--)
        {
            var node = col[i];
            cb(node);
        }
    }

    _dumpToFile(scope)
    {
        return Promise.resolve()
            .then(() => {
                var writer = this.logger.outputStream("dump-logic-tree");
                if (writer) {
                    scope.root.debugOutputToFile(writer);
                    return writer.close();
                }
            })
            .then(() => {
                var writer = this.logger.outputStream("dump-logic-tree-detailed");
                if (writer) {
                    scope.root.debugOutputToFile(writer, { includeConfig: true });
                    return writer.close();
                }
            })
            .then(() => {
                var writer = this.logger.outputStream("exported-tree");
                if (writer) {
                    writer.write(this._context.facadeRegistry.logicTree);
                    return writer.close();
                }
            });
    }


}

module.exports = LogicProcessor;