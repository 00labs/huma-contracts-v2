// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

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
                creditType: RECEIVABLE_BACKED_CREDIT_LINE,
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
        rbCreditLineHandler = new ReceivableBackedCreditLineHandler(borrowers);
        rbCreditLineHandler.approveBorrowers(_toToken(MAX_CREDIT_LIMIT) / 2, CREDIT_YIELD_BPS);
        // creditLineHandler = new CreditLineHandler(borrowers);
        // creditLineHandler.approveBorrowers(_toToken(MAX_CREDIT_LIMIT) / 2, CREDIT_YIELD_BPS);

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

        selectors = new bytes4[](7);
        selectors[0] = selectors[1] = selectors[2] = rbCreditLineHandler
            .drawdownWithReceivable
            .selector;
        selectors[3] = rbCreditLineHandler.makePaymentWithReceivable.selector;
        selectors[4] = rbCreditLineHandler.makePrincipalPaymentWithReceivable.selector;
        selectors[5] = rbCreditLineHandler.makePrincipalPaymentAndDrawdownWithReceivable.selector;
        selectors[6] = rbCreditLineHandler.refreshCredit.selector;
        targetSelector(FuzzSelector({addr: address(rbCreditLineHandler), selectors: selectors}));
        targetContract(address(rbCreditLineHandler));

        // selectors = new bytes4[](6);
        // selectors[0] = selectors[1] = selectors[2] = creditLineHandler.drawdown.selector;
        // selectors[3] = selectors[4] = creditLineHandler.makePayment.selector;
        // selectors[5] = creditLineHandler.refreshCredit.selector;
        // targetSelector(FuzzSelector({addr: address(creditLineHandler), selectors: selectors}));
        // targetContract(address(creditLineHandler));
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
        rbCreditLineHandler.makePrincipalPaymentAndDrawdownWithReceivable(
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            3,
            22788289443144963299136999770583787545640652083010549363838,
            2
        );
        rbCreditLineHandler.makePrincipalPaymentAndDrawdownWithReceivable(
            2691,
            4238513535945,
            215,
            1983
        );
        rbCreditLineHandler.drawdownWithReceivable(
            3878562887641857190945011324742947258046911287696535233,
            465978703882356961592379874803930,
            0
        );
        rbCreditLineHandler.makePrincipalPaymentWithReceivable(5290, 1206, 1308);
        liquidityHandler.disburse(3, 101002297727347737, 199151947794161789121398819347);
        liquidityHandler.addRedemptionRequest(1502, 17706, 12579, 13861);
        liquidityHandler.withdrawPoolOwnerFee(0, 6);
        liquidityHandler.cancelRedemptionRequest(5171, 4661, 10908, 24411);
        liquidityHandler.addRedemptionRequest(3792, 34417, 11514, 11147);
        rbCreditLineHandler.makePrincipalPaymentWithReceivable(
            772931628185164769239091166635619238658305254149721108401233174524111,
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            0
        );
        liquidityHandler.addRedemptionRequest(
            1,
            115792089237316195423570985008687907853269984665640564039457584007913129639932,
            33216614510659856966940055975913017456357573107501548973788,
            115792089237316195423570985008687907853269984665640564039457584007913129639935
        );
        rbCreditLineHandler.makePaymentWithReceivable(
            16888,
            12073,
            473745687804409714323878541972247001183660
        );
        liquidityHandler.deposit(
            79648434596973584967864216352591063277839227808056240329825739938052455162707,
            10095,
            200000010082,
            16979
        );
        liquidityHandler.withdrawProtocolFee(2189330705504424476372184687553, 14282406702);
        rbCreditLineHandler.refreshCredit(294, 21407);
        liquidityHandler.addRedemptionRequest(
            32458597901748140005968589770647574123769,
            15467101292360452382143368610670202549,
            8478411710415529876124,
            115792089237316195423570985008687907853269984665640564039457584007913129639935
        );
        rbCreditLineHandler.refreshCredit(
            3,
            115792089237316195423570985008687907853269984665640564039457584007913129639934
        );
        rbCreditLineHandler.makePrincipalPaymentAndDrawdownWithReceivable(
            11803,
            2576,
            6971,
            344662576652243469721435640171710866217
        );
        liquidityHandler.processYieldForLenders(
            35983222580426468139908544811619096550624656227001345252,
            11548288141986360995140109898920128168056393807
        );
        rbCreditLineHandler.makePaymentWithReceivable(
            1,
            2161940855342391292872524652586360927080670296223599743566046144126584134497,
            0
        );
        liquidityHandler.addRedemptionRequest(
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            267527196642402639407305903009800009145643320047575289653,
            9584688538686150623,
            37053191810327812672267866827828780594033610945043891352933439184125
        );
        rbCreditLineHandler.drawdownWithReceivable(
            3,
            3119182089827284015614947261212429386472591443896914886317802037,
            3
        );
    }

    function invariant_displayCallsLog() public view {
        displayCallsLog();
    }
}
