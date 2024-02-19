// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {BaseInvariants, PoolDeployParameters} from "./BaseInvariants.sol";
import {LiquidityHandler} from "./handlers/LiquidityHandler.sol";
import {CreditLineHandler} from "./handlers/CreditLineHandler.sol";
import {CreditLine} from "contracts/credit/CreditLine.sol";
import {CreditLineManager} from "contracts/credit/CreditLineManager.sol";
import {ReceivableBackedCreditLineHandler} from "./handlers/ReceivableBackedCreditLineHandler.sol";

import "forge-std/console.sol";

contract TestInvariants is BaseInvariants {
    uint96 constant MAX_CREDIT_LIMIT = 10_000_000;
    uint96 constant LIQUIDITY_CAP = 10_000_000;
    uint16 constant FIXED_SENIOR_YIELD_BPS = 1000;
    uint16 constant RISK_ADJUSTED_BPS = 1500;
    uint16 constant CREDIT_YIELD_BPS = 1500;

    LiquidityHandler liquidityHandler;
    ReceivableBackedCreditLineHandler rbCreditLineHandler;
    CreditLineHandler creditLineHandler;

    function setUp() public override {
        super.setUp();

        _setUp(
            PoolDeployParameters({
                tranchesPolicyType: FIXED_SENIOR_YIELD_TRANCHES_POLICY,
                // creditType: RECEIVABLE_BACKED_CREDIT_LINE,
                creditType: CREDIT_LINE,
                maxCreditLimit: MAX_CREDIT_LIMIT,
                liquidityCap: LIQUIDITY_CAP,
                fixedSeniorYieldBps: FIXED_SENIOR_YIELD_BPS,
                riskAdjustedBps: RISK_ADJUSTED_BPS,
                creditYieldBps: CREDIT_YIELD_BPS
            }),
            10,
            10
        );

        liquidityHandler = new LiquidityHandler(lenders);
        // rbCreditLineHandler = new ReceivableBackedCreditLineHandler(borrowers);
        // rbCreditLineHandler.approveBorrowers(_toToken(MAX_CREDIT_LIMIT) / 2, CREDIT_YIELD_BPS);
        creditLineHandler = new CreditLineHandler(borrowers);
        creditLineHandler.approveBorrowers(_toToken(MAX_CREDIT_LIMIT) / 2, CREDIT_YIELD_BPS);

        addSelector(liquidityHandler.deposit.selector, "deposit");
        addSelector(liquidityHandler.addRedemptionRequest.selector, "addRedemptionRequest");
        addSelector(liquidityHandler.cancelRedemptionRequest.selector, "cancelRedemptionRequest");
        addSelector(liquidityHandler.disburse.selector, "disburse");
        addSelector(liquidityHandler.processYieldForLenders.selector, "processYieldForLenders");
        addSelector(liquidityHandler.withdrawProtocolFee.selector, "withdrawProtocolFee");
        addSelector(liquidityHandler.withdrawPoolOwnerFee.selector, "withdrawPoolOwnerFee");
        addSelector(liquidityHandler.withdrawEAFee.selector, "withdrawEAFee");
        addSelector(rbCreditLineHandler.drawdownWithReceivable.selector, "drawdownWithReceivable");
        addSelector(
            rbCreditLineHandler.makePaymentWithReceivable.selector,
            "makePaymentWithReceivable"
        );
        addSelector(
            rbCreditLineHandler.makePrincipalPaymentWithReceivable.selector,
            "makePrincipalPaymentWithReceivable"
        );
        addSelector(
            rbCreditLineHandler.makePrincipalPaymentAndDrawdownWithReceivable.selector,
            "makePrincipalPaymentAndDrawdownWithReceivable"
        );
        addSelector(rbCreditLineHandler.refreshCredit.selector, "refreshCredit");

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = selectors[1] = selectors[2] = liquidityHandler.deposit.selector;
        selectors[3] = selectors[4] = liquidityHandler.addRedemptionRequest.selector;
        selectors[5] = liquidityHandler.cancelRedemptionRequest.selector;
        selectors[6] = liquidityHandler.disburse.selector;
        selectors[7] = liquidityHandler.processYieldForLenders.selector;
        selectors[8] = liquidityHandler.withdrawProtocolFee.selector;
        selectors[9] = liquidityHandler.withdrawPoolOwnerFee.selector;
        selectors[10] = liquidityHandler.withdrawEAFee.selector;
        targetSelector(FuzzSelector({addr: address(liquidityHandler), selectors: selectors}));
        targetContract(address(liquidityHandler));

        // selectors = new bytes4[](7);
        // selectors[0] = selectors[1] = selectors[2] = rbCreditLineHandler
        //     .drawdownWithReceivable
        //     .selector;
        // selectors[3] = rbCreditLineHandler.makePaymentWithReceivable.selector;
        // selectors[4] = rbCreditLineHandler.makePrincipalPaymentWithReceivable.selector;
        // selectors[5] = rbCreditLineHandler.makePrincipalPaymentAndDrawdownWithReceivable.selector;
        // selectors[6] = rbCreditLineHandler.refreshCredit.selector;
        // targetSelector(FuzzSelector({addr: address(rbCreditLineHandler), selectors: selectors}));
        // targetContract(address(rbCreditLineHandler));

        selectors = new bytes4[](6);
        selectors[0] = selectors[1] = selectors[2] = creditLineHandler.drawdown.selector;
        selectors[3] = selectors[4] = creditLineHandler.makePayment.selector;
        selectors[5] = creditLineHandler.refreshCredit.selector;
        targetSelector(FuzzSelector({addr: address(creditLineHandler), selectors: selectors}));
        targetContract(address(creditLineHandler));
    }

    function testBoundNew1() public {
        uint256 result = liquidityHandler.boundNew(10089, 1000000, 1000000);
        assertEq(result, 1000000);
    }

    function testBoundNew2() public {
        uint256 result = liquidityHandler.boundNew(0, 1000000, 445809192099);
        assertEq(result, 1000000);
    }

    function testDebug() public {
        creditLineHandler.drawdown(18455, 4614392927512, 11597);
        creditLineHandler.drawdown(
            0,
            11463746569123900029188,
            151419055274492630647886040402064834348691834069542595638211528775
        );
        liquidityHandler.deposit(
            65852510840017832,
            115792089237316195423570985008687907853269984665640564039457584007913129639932,
            3,
            794895041885095763150322620559
        );
        liquidityHandler.disburse(
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            12982382883825859164107948906997
        );
        liquidityHandler.deposit(
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            740334503769013376646876543905,
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            75
        );
        liquidityHandler.withdrawProtocolFee(
            27294521293129950061425153219375224232,
            298568782060049936960713242573281253617953101589573558583970204592674663354
        );
        liquidityHandler.withdrawEAFee(
            115792089237316195423570985008687907853269984665640564039457584007913129639932,
            2
        );
        creditLineHandler.drawdown(
            52654564402925853901503181827445736792137557331502261610918769361694108942336,
            543194293730,
            12695496156
        );
        liquidityHandler.addRedemptionRequest(
            0,
            3963330332443050585507972138249022489309937591143422288435,
            1,
            115792089237316195423570985008687907853269984665640564039457584007913129639933
        );
        creditLineHandler.refreshCredit(3700072462751, 8332);
        creditLineHandler.drawdown(5275, 11845401723, 32185071841355503813483865071006360937520);
        creditLineHandler.drawdown(685846442289796434209, 15733033952, 15252485);
        liquidityHandler.deposit(
            283273706026760422099953457705811644996792279351509618756825,
            23619557970312167936440242666408187834816330297101959455985441399167833341952,
            4691481403,
            1707189113049
        );
        liquidityHandler.withdrawPoolOwnerFee(
            126404927220,
            1472185281731802481685766990544238172368
        );
        creditLineHandler.refreshCredit(3725265400322527, 9324793);
        liquidityHandler.deposit(
            40783,
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            115792089237316195423570985008687907853269984665640564039457584007913129639932,
            115792089237316195423570985008687907853269984665640564039457584007913129639933
        );
        creditLineHandler.drawdown(
            11044041549,
            267906223448276425708608868137460369867251,
            1010476
        );
        creditLineHandler.makePayment(
            2413182844817383949717667166469609,
            4591508454,
            7266342850444717857718117579019538567150
        );
        creditLineHandler.drawdown(
            42066906012497600072966137177078092578621186,
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            397186407
        );
        creditLineHandler.makePayment(
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            31137365061465016210111273484247012976480667,
            115792089237316195423570985008687907853269984665640564039457584007913129639933
        );
        creditLineHandler.drawdown(
            96347290722002155101798147741501,
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            13804068400330851
        );
        liquidityHandler.addRedemptionRequest(
            471647293376,
            23605409558083967602164503069860698332429915261977517212486488959809029668864,
            1707189113490,
            21092
        );
        creditLineHandler.drawdown(1608994236229634524674312755836813073670, 532, 1397151978400);
        creditLineHandler.makePayment(
            135222317767305595424695725902512712635,
            1474246880959,
            3377957696648
        );
        liquidityHandler.withdrawPoolOwnerFee(
            1338824491107715187160469983407082621575922289293004671811585,
            28993081238
        );
        creditLineHandler.makePayment(
            34585382314539623704395301705305624304550,
            10495,
            70247358258265447348967373764746741277
        );
        creditLineHandler.drawdown(
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            115792089237316195423570985008687907853269984665640564039457584007913129639932
        );
        creditLineHandler.makePayment(552420154713, 8717512440016, 1132507255952);
        liquidityHandler.addRedemptionRequest(
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            36292826447264866601227710893869927314888016,
            115792089237316195423570985008687907853269984665640564039457584007913129639934
        );
        liquidityHandler.addRedemptionRequest(
            19783,
            91016600307,
            540567602237451072926996903803827581801145,
            301586076344911422350143871645438375502
        );
        liquidityHandler.withdrawEAFee(
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            0
        );
        creditLineHandler.makePayment(
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            0
        );
        creditLineHandler.refreshCredit(673562657065154207164138066018464297334845776214, 0);
        creditLineHandler.refreshCredit(
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            115792089237316195423570985008687907853269984665640564039457584007913129639934
        );
        liquidityHandler.withdrawPoolOwnerFee(
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            0
        );
        liquidityHandler.deposit(
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            11535709284865717808603634848973084285994500703197639372745664602,
            48788719390305804003196072941819653204984348602526802,
            382767920450804123338031906548602
        );
        creditLineHandler.drawdown(589883466153, 97946880053480509602556926867831648258867, 905);
        liquidityHandler.deposit(
            49959768772860965533076120944314085754277968506383220744801743099823881453568,
            638641089,
            4163315295181,
            1704154200
        );
        liquidityHandler.deposit(
            120322191176174003461347878513953877961844764,
            115792089237316195423570985008687907853269984665640564039457584007913129639932,
            1025558270110008071,
            0
        );
        creditLineHandler.makePayment(3020, 11729002940, 10073270540);
        creditLineHandler.drawdown(
            496323760598,
            38122023921750010126188323,
            45509401591581653477236381555
        );
        liquidityHandler.processYieldForLenders(580680182319388516963938324484012955457797, 6216);
        creditLineHandler.refreshCredit(
            215475360332977114115160333045712409496227531914984504982146265059547,
            17065148588641
        );
        liquidityHandler.withdrawEAFee(
            1446507072977,
            45417600155401643925298384910109722496118378785854834166902522508972268745833
        );
        liquidityHandler.addRedemptionRequest(
            1299646729173,
            874980811,
            11535709284865717808603634848973084285994500703197639372745664602,
            318722101654357751305662578928895649735
        );
        liquidityHandler.deposit(
            52654564402925853901503181827445736792137557331502569868002624696212820852736,
            44029879307072689098830556922311112666787196121470373414562,
            1707189113187,
            1131035599
        );
        liquidityHandler.processYieldForLenders(
            1,
            115792089237316195423570985008687907853269984665640564039457584007913129639934
        );
        liquidityHandler.withdrawPoolOwnerFee(
            4560989161068235126924911949049219984946631760237863892697727806846989,
            9638176084851615791809620441083735069121343588845537081304595183927501636337
        );
        creditLineHandler.drawdown(
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            1611665060749252245902816835631778,
            3
        );
        creditLineHandler.makePayment(1928786169951, 5842, 5972871937726);
        creditLineHandler.refreshCredit(34585382314460395541881037367677808586925, 1707189113699);
        liquidityHandler.cancelRedemptionRequest(
            3,
            11169954000788384,
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            3
        );
        creditLineHandler.refreshCredit(
            115792089237316195423570985008687907853269984665640564039457584007913129639932,
            3
        );
        liquidityHandler.withdrawProtocolFee(9445427878502661342305932325636330066266, 1);
        creditLineHandler.makePayment(
            16272,
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            0
        );
        creditLineHandler.drawdown(
            1443,
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            2
        );
        liquidityHandler.addRedemptionRequest(
            684345172525,
            115792089237316195423570985008687907853269984665640564039457584007913129639932,
            6,
            1415638524929290512289976916506741229825791183111187169001294292
        );
        creditLineHandler.refreshCredit(
            2976433676661256805067517166070808427996876,
            436026850695146526441007567871818629581622567874117197027362237340
        );
        liquidityHandler.deposit(
            21196305460915086879895965862905642438688982864182079058699179124,
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            11635758063325109219328483759418473838615748645150915800832055734588005,
            2140759
        );
        liquidityHandler.cancelRedemptionRequest(
            1,
            91450343808636262085864295221815300834972,
            2,
            68858820334747495129172584275601
        );
        liquidityHandler.addRedemptionRequest(3979, 252259613953, 13000453366, 359354392176);
        liquidityHandler.addRedemptionRequest(
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            0,
            482037736387250458626573697474482349605120883,
            1526167780095451171501222439002738943876436279018552766719048052962296428293
        );
        liquidityHandler.withdrawEAFee(14027266291, 110640591607904720664177461520282662531);
        creditLineHandler.drawdown(
            14679693046863453544749119930099448391003035416531251219053913297792270336000,
            1707189112779,
            45410512412168470896510625518551056484623551074279046533212910245221503869044
        );
        creditLineHandler.drawdown(
            38180553247522070543472540534464902866931198124949994516620531851002063643490,
            199595134558,
            1707189113580
        );
        creditLineHandler.drawdown(
            190049429605784400689500204151052453656453092921192677699465031556,
            3,
            901189795104318223467
        );
        liquidityHandler.deposit(
            30065997677601797697437696,
            45887588670831293672362525371923446398501355475715707902551123796152880726016,
            79228162672720662622072625547295353972,
            80884365138984552700616971426310924734800135791252209787936289422562
        );
        liquidityHandler.disburse(
            1749037274972375661240235149144024776071,
            19959093976347730912524023524639228906755147289766504319432835322102186770432,
            8186
        );
        liquidityHandler.disburse(
            105429031052027294307753646315100182570764735088811248040889822125870,
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            64
        );
        creditLineHandler.drawdown(
            2993624976732419532918224295295391305844229826234935757744,
            81127548244596667424799282704336799715609631597532685901022064296,
            0
        );
        creditLineHandler.makePayment(
            3,
            2,
            458342756065326411743105653642900206865994223561668621319
        );
        creditLineHandler.drawdown(
            21930916909860963224120,
            36940693051630883364302515705706049,
            115792089237316195423570985008687907853269984665640564039457584007913129639933
        );
        creditLineHandler.refreshCredit(3, 3);
        liquidityHandler.withdrawEAFee(90000007751, 3856056066);
        creditLineHandler.refreshCredit(198374040, 0);
        creditLineHandler.refreshCredit(0, 3);
        creditLineHandler.drawdown(6003230769286196163309510661994726866476, 1385876620645, 4455);
        creditLineHandler.drawdown(
            3,
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            115792089237316195423570985008687907853269984665640564039457584007913129639934
        );
        liquidityHandler.addRedemptionRequest(
            14679693046863453544749119930099448391003035416531251214404829388059197833216,
            36413971917,
            7124,
            10549
        );
        liquidityHandler.processYieldForLenders(
            2383520033,
            542090308723775127597123281920481358697145
        );
        _assert_PoolFeeManager_A();
        _assert_PoolFeeManager_B();
        _assert_PoolFeeManager_C();
        _assert_PoolFeeManager_D();
    }

    function invariant_displayCallsLog() public view {
        displayCallsLog();
    }
}
