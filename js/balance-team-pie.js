// instance variables
var userBucket;
var userCollection;
var pieView;

$(document).ready(function(){

// Simperium configuration
// bubbles@493.com
var SIMPERIUM_OPTS = {
    host            : 'api.simperium.com',
    // port            : '9999',
    // auth_host       : '33.33.33.10:8888',
    // client_id       : 'b112c2c457f946938be164e96f1cf979',
    token        : 'cf2104fd0d124dbdb28c84bfb309e561',
    stream_index    : true,
    update_delay    : 1,
};
var SIMPERIUM_APP_ID = 'ideal-whip-7c7';


// User Model
var User = Backbone.Model.extend({
    defaults: function() {
      return {
        order: 0
      };
    }
});


// User Collection
var UserCollection = Backbone.SimperiumCollection.extend({
    model: User,
    initialize: function(models, options) {
        this.bind('change:order', function(){
            this.sort()
        }, this);
        Backbone.SimperiumCollection.prototype.initialize.call(this, models, options);
    },
    comparator: function(item) {
        return item.get('order');
    }
});

// Views
var UserView = Backbone.View.extend({
    tagName:  "li",
    template: _.template($('#user-template').html()),
    render: function() {
        var data = this.model.toJSON();
        data['id'] = this.model.id;
        $(this.el).html(this.template(data));
        return this;
    }
});


var PieView = Backbone.View.extend({
    el: $("#pie-page"),

    initialize: function() {
        // enable sorting
        $(".sortable").sortable({
            update: function(el, ui) {
                $(this).find('li > div').each(function(i){
                    var id = $(this).attr('data-id');
                    item = userCollection.get(id);
                    if(item.get('order') != i+1)
                        item.save({order: i+1});
                });
            },
        });
        $(".sortable" ).disableSelection();



        userCollection.bind('all', this.render, this);
        userCollection.fetch();
    },

    render: function() {
        $("#user-list").html('');
        userCollection.each(this.addOne);
    },

    addOne: function(user) {
        var view = new UserView({model: user});
        $("#user-list").append(view.render().el);
    }
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

    console.log('oh hi');
    $('#slider').slider();

     document.ontouchmove = function(e) {
             e.preventDefault();
                 };

});
