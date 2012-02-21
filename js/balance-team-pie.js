// instance variables
var userBucket;
var userCollection;
var pieView;

$(document).ready(function(){

// Simperium configuration
var SIMPERIUM_OPTS = {
    host            : '33.33.33.10',
    port            : '9999',
    auth_host       : '33.33.33.10:8888',
    // client_id       : 'b112c2c457f946938be164e96f1cf979',
    token        : 'c04614ff415648b0be9db2a80da7af1e',
    stream_index    : true,
    update_delay    : 1,
};
var SIMPERIUM_APP_ID = 'app-specialists-793';


// User Model
var User = Backbone.Model.extend({
    defaults: function() {
      return {
        //done:  false,
        //order: Todos.nextOrder()
      };
    }
});


// User Collection
var UserCollection = Backbone.SimperiumCollection.extend({
    model: User
});

// Views
var UserView = Backbone.View.extend({
    tagName:  "li",
    template: _.template($('#user-template').html()),

    initialize: function() {
      this.model.bind('change', this.render, this);
      this.model.bind('destroy', this.remove, this);
    },

    render: function() {
      $(this.el).html(this.template(this.model.toJSON()));
      // this.setText();
      return this;
    }
});


var PieView = Backbone.View.extend({
    el: $("#pie-page"),

    initialize: function() {
      // this.input    = this.$("#new-todo");
      userCollection.bind('add',   this.addOne, this);
      userCollection.bind('reset', this.addAll, this);
      userCollection.bind('all',   this.render, this);
      userCollection.fetch();
    },

    render: function() {
    },

    addOne: function(user) {
        var view = new UserView({model: user});
        $("#user-list").append(view.render().el);
    },

    addAll: function() {
      userCollection.each(this.addOne);
    },
});


function start_pie(pie_name) {
    $('#splash-page').hide();
    $('#pie-page').show();

    userBucket = new Simperium(SIMPERIUM_APP_ID, pie_name, SIMPERIUM_OPTS);
    userCollection = new UserCollection([], {simperium:userBucket});
    pieView = new PieView;
}


    var address = $.address.value();
    if (address != '/') {
        var pie_name = address.substring(1);
        start_pie(pie_name);
    }

    $('.start-next').click(function(){
        var pie_name = $('#start-url').val();
        if (pie_name) { 
            $.address.value(pie_name);
            start_pie(pie_name);
        }
    });
});
