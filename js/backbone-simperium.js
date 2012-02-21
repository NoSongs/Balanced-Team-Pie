Backbone.SimperiumCollection = Backbone.Collection.extend({
    initialize: function(models, options) {
        _.bindAll(this, "remote_update", "get_data");
        this.simperium = options.simperium;
        this.simperium.set_notify(this.remote_update);
        this.simperium.set_get_data(this.get_data);
        this.simperium.start();
    },

    remote_update: function(id, data) {
        var model = this.get(id);
        if (data == null) {
            if (model) {
                model.destroy();
            }
        } else {
            if (model) {
                model.set(data);
            } else {
                model = new this.model(data);
                model.id = id;
                this.add(model);
            }
        }
    },

    get_data: function(id) {
        var model = this.get(id);
        if (model) {
            return model.toJSON();
        }
        return null;
    },
});

Backbone.sync = function(method, model, options) {
    console.log("method:" +method+ " model: " +model+ "/" +JSON.stringify(model.toJSON())+
                    " options: " +JSON.stringify(options));
    if (!model) return;
    var S4 = function() {
        return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
    };

    var simperium = model.simperium || model.collection && model.collection.simperium;
    if (!simperium) return;

    var isModel = !(typeof model.isNew === 'undefined');
    console.log("isModel: "+isModel);
    if (isModel) {
        if (model.isNew()) {
            model.id = S4()+S4()+S4()+S4()+S4();
            model.trigger("change:id", model, model.collection, {});
        }

        switch (method) {
            case "read"     : options.success(simperium.get(model.id)); break;
            case "create"   :
            case "update"   : simperium.update(model.id, model.toJSON()); options.success(); break;
            case "delete"   : simperium.update(model.id, null); options.success(); break;
        }
    } else {
        switch (method) {
            case "read"     : {
                var init_data = []
//                    var data = simperium.get_all_data();
                var data = {};
                for (id in data) {
                    if ('id' in data[id]) {
                        data[id]['___id'] = data[id].id;
                    }
                    data[id].id = id
                    init_data.push(data[id]);
                }
                options.success(init_data);
                model.each(function(model) {
                    var id = model.id;
                    if (model.has('___id')) {
                        model.set({id:model.get('___id')}, {silent: true})
                        model.unset('___id', {silent: true});
                    } else {
                        model.unset('id', {silent:true});
                    }
                    model.id = id;
                });
                break;
            }
        }
    }
};
