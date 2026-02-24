(function ($) {

var selectors = {};
	selectors.codigo = 'input.codigo';
	selectors.producto = 'select.producto';
	selectors.pais = 'input.pais';

var msgs = {};
	msgs.wrongcode = 'Ingrese un valor correcto';
	msgs.wrongpart = 'Pieza mal ingresada';
	msgs.wrongcountry = 'Ingrese un país en formato XX Ej.: AR';

$(document).ready(function() {
	$("#btsubmit").click(function(e) {
		e.preventDefault();
		ajax_request($('.action').val(), true, 'html', seguimientoResult, false);
	});
});

$(document).keypress(function(e) {
	if(e.which == 13) {
		e.preventDefault();
		ajax_request($('.action').val(), true, 'html', seguimientoResult, false);
	}
});

 function ajax_request(thisaction, validate, dataType, callback, validateCaptcha) {
	var jsonData = {};

	jsonData.action = thisaction;
	jsonData.id = $(selectors.codigo).val();
	jsonData.producto = $(selectors.producto).val();
	jsonData.pais = $(selectors.pais).val();

	var flag = false;
	if ( validate ) flag = validate_seguimiento_forms(jsonData, selectors)

	if ( !flag ) {
		doAjaxPost(
			'/sites/all/modules/custom/ca_forms/api/wsFacade.php'
			,jsonData
			,dataType
			,callback
			,validateCaptcha
			);
		return;
	}
}

function validate_seguimiento_forms(jsonData, selectors) {
	var flag = false;

	if ((jsonData.action=='ondng') // DNI
		||(jsonData.action=='onpa')) { // PASAPORTE
			if ( !validarPiezaDNIyPasaporte(jsonData, $('#numero')) ) {
				show_tooltip(selectors.codigo, msgs.wrongcode);
				flag = true;
			}
	}else if(jsonData.action=='oidn') { // Correspondencia con origen internacional y destino nacional

			var ruleId = /[a-zA-Z]{2}\d{9}[a-zA-Z]{2}/;

			if(!ruleId.test(jsonData.id) || !jsonData.id.length) {
				 show_tooltip(selectors.codigo, msgs.wrongcode);
				 flag = true;
			}
	}else if((jsonData.action=='ondi') // Correspondencia con origen nacional y destino internacional
					||(jsonData.action=='ondnc') // Correspondencia con origen nacional y destino nacional
					||(jsonData.action=='ondnp')) { // Correspondencia con origen y destino nacional Plus

			var ruleId = /^\d{7,9}$/;
			var rulePais = /^[a-zA-Z]{2}$/;
			if(!ruleId.test(jsonData.id) || !jsonData.id.length) {
				show_tooltip(selectors.codigo, msgs.wrongpart);
				flag = true;
			}
			if(!rulePais.test(jsonData.pais) || !jsonData.pais.length) {
				show_tooltip(selectors.pais, msgs.wrongcountry);
				flag = true;
			}
	}
	else if ( jsonData.action=='mercadolibre' ) {
		if ( !validarPiezaEcommerce(jsonData.id)) {
			show_tooltip(selectors.codigo, msgs.wrongcode);
			flag = true;
		}
	}
	else if ( jsonData.action=='ecommerce' ) {
		if ( !validarPiezaEcommerce(jsonData.id)) {
			show_tooltip(selectors.codigo, msgs.wrongcode);
			flag = true;
		}
	}

	return flag;
}

// Muestra el resultado del seguimiento
function seguimientoResult(res) {
	$('#resultado').html(res);
}

})(jQuery);
