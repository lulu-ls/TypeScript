//// [collisionSuperAndPropertyNameAsConstuctorParameter.ts]
class a {
}

class b1 extends a {
    constructor(_super: number) { // should be error
        super();
    }
}

class b2 extends a {
    constructor(private _super: number) { // should be error
        super();
    }
}

class b3 extends a {
    constructor(_super: number); // no code gen - no error
    constructor(_super: string);// no code gen - no error
    constructor(_super: any) { // should be error
        super();
    }
}

class b4 extends a {
    constructor(_super: number); // no code gen - no error
    constructor(_super: string);// no code gen - no error
    constructor(private _super: any) { // should be error
        super();
    }
}

//// [collisionSuperAndPropertyNameAsConstuctorParameter.js]
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var a = /** @class */ (function () {
    function a() {
    }
    return a;
}());
var b1 = /** @class */ (function (_super_1) {
    __extends(b1, _super_1);
    function b1(_super) {
        return _super_1.call(this) || this;
    }
    return b1;
}(a));
var b2 = /** @class */ (function (_super_1) {
    __extends(b2, _super_1);
    function b2(_super) {
        var _this = _super_1.call(this) || this;
        _this._super = _super;
        return _this;
    }
    return b2;
}(a));
var b3 = /** @class */ (function (_super_1) {
    __extends(b3, _super_1);
    function b3(_super) {
        return _super_1.call(this) || this;
    }
    return b3;
}(a));
var b4 = /** @class */ (function (_super_1) {
    __extends(b4, _super_1);
    function b4(_super) {
        var _this = _super_1.call(this) || this;
        _this._super = _super;
        return _this;
    }
    return b4;
}(a));
