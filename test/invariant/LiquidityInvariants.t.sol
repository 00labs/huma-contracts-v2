// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseTest} from "./BaseTest.sol";
import {PayPeriodDuration} from "contracts/common/SharedDefs.sol";
import {PoolFactory} from "contracts/factory/PoolFactory.sol";
import {PoolConfig, PoolSettings, LPConfig, FrontLoadingFeesStructure, FeeStructure, FirstLossCoverConfig} from "contracts/common/PoolConfig.sol";
import {BORROWER_LOSS_COVER_INDEX, ADMIN_LOSS_COVER_INDEX} from "contracts/common/SharedDefs.sol";
import {InvariantHandler} from "./handlers/InvariantHandler.sol";
import {EpochManager} from "contracts/liquidity/EpochManager.sol";

import "forge-std/console.sol";

contract LiquidityInvariants is BaseTest {
    uint256 constant MAX_CREDIT_LINE = 10_000_000;
    uint256 constant LIQUIDITY_CAP = 10_000_000;
    uint16 constant FIXED_SENIOR_YIELD_BPS = 1000;
    uint16 constant RISK_ADJUSTED_BPS = 1500;
    uint16 constant YIELD_BPS = 1500;

    function setUp() public override {
        super.setUp();

        _deployPool(FIXED_SENIOR_YIELD_TRANCHES_POLICY, CREDIT_LINE);
        PoolFactory.PoolRecord memory poolRecord = poolFactory.checkPool(poolId);
        PoolConfig poolConfig = PoolConfig(poolRecord.poolConfigAddress);

        vm.startPrank(poolOwner);
        poolConfig.setPoolSettings(
            PoolSettings(
                uint96(_toToken(MAX_CREDIT_LINE)),
                uint96(_toToken(100)),
                PayPeriodDuration.Monthly,
                5,
                90,
                10000,
                true
            )
        );
        poolConfig.setLPConfig(
            LPConfig(
                uint96(_toToken(LIQUIDITY_CAP)),
                4,
                FIXED_SENIOR_YIELD_BPS,
                RISK_ADJUSTED_BPS,
                0
            )
        );
        poolConfig.setFrontLoadingFees(FrontLoadingFeesStructure(0, 1000));
        poolConfig.setFeeStructure(FeeStructure(YIELD_BPS, 0, 1200));
        poolConfig.setPoolOwnerRewardsAndLiquidity(200, 200);
        poolConfig.setEARewardsAndLiquidity(200, 200);
        poolConfig.setFirstLossCover(
            uint8(BORROWER_LOSS_COVER_INDEX),
            poolConfig.getFirstLossCover(BORROWER_LOSS_COVER_INDEX),
            FirstLossCoverConfig(
                1000,
                uint96(_toToken(100_000)),
                uint96(_toToken(1_000_000)),
                uint96(_toToken(1_000_000)),
                0
            )
        );
        poolConfig.setFirstLossCover(
            uint8(ADMIN_LOSS_COVER_INDEX),
            poolConfig.getFirstLossCover(ADMIN_LOSS_COVER_INDEX),
            FirstLossCoverConfig(
                1000,
                uint96(_toToken(100_000)),
                uint96(_toToken(3_000_000)),
                uint96(_toToken(1_000_000)),
                15000
            )
        );
        vm.stopPrank();

        _enablePool();

        // EpochManager.CurrentEpoch memory epoch = EpochManager(poolConfig.epochManager())
        //     .currentEpoch();
        // console.log(
        //     "epoch.id: %s, epoch.endTime: %s, timestamp: %s",
        //     epoch.id,
        //     epoch.endTime,
        //     vm.unixTime()
        // );

        _createUsers(10, 10);
        _approveBorrowers(_toToken(MAX_CREDIT_LINE) / 2, YIELD_BPS);

        handler = new InvariantHandler(address(poolConfig), lenders, borrowers);

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.deposit.selector;
        selectors[2] = handler.deposit.selector;
        selectors[3] = handler.addRedemptionRequest.selector;
        selectors[4] = handler.addRedemptionRequest.selector;
        selectors[5] = handler.cancelRedemptionRequest.selector;
        selectors[6] = handler.disburse.selector;
        selectors[7] = handler.processYieldForLenders.selector;
        selectors[8] = handler.drawdown.selector;
        selectors[9] = handler.drawdown.selector;
        selectors[10] = handler.drawdown.selector;
        selectors[11] = handler.makePayment.selector;
        selectors[12] = handler.makePayment.selector;
        selectors[13] = handler.refreshCredit.selector;

        // bytes4[] memory selectors = new bytes4[](8);
        // selectors[0] = handler.deposit.selector;
        // selectors[1] = handler.addRedemptionRequest.selector;
        // selectors[2] = handler.cancelRedemptionRequest.selector;
        // selectors[3] = handler.disburse.selector;
        // selectors[4] = handler.processYieldForLenders.selector;
        // selectors[5] = handler.drawdown.selector;
        // selectors[6] = handler.makePayment.selector;
        // selectors[7] = handler.refreshCredit.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function testSetUp() public {
        assertTrue(true);
    }

    function testDeposit() public {
        handler.deposit(
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            3694087947,
            9093720506176389639203518624136341032157519068214917631426822148,
            26447
        );
    }

    function testBoundNew1() public {
        uint256 result = handler.boundNew(10089, 1000000, 1000000);
        assertEq(result, 1000001);
    }

    function testBoundNew2() public {
        uint256 result = handler.boundNew(0, 1000000, 445809192099);
        assertEq(result, 1000000);
    }

    function invariant_test() public {
        assertTrue(false);
        // assertGe(1, 0, "test");
    }

    // A: totalAssets >= totalSupply
    function invariant_Tranche_A() public {
        _assert_Tranche_A();
    }

    function invariant_Tranche_B() public {
        _assert_Tranche_B();
    }

    function invariant_Tranche_C() public {
        _assert_Tranche_C();
    }

    // D: ∑assetsOf >= ∑balanceOf
    // E: ∑balanceOf == totalSupply
    // F: ∑assetsOf == totalAssets
    function invariant_Tranche_D_E_F() public {
        _assert_Tranche_D_E_F();
    }

    function test_Tranche_invariants() public {
        _assert_Tranche_A();
        _assert_Tranche_B();
        _assert_Tranche_D_E_F();
        _assert_Tranche_J();
    }

    function testDebug() public {
        handler.refreshCredit(
            551261801030898639982215876683954685800,
            75504471781899318940636525190984073457601096645995950768128
        );
        handler.makePayment(
            367077249228269720332219042875667811367558582061215096582,
            0,
            3399497307575075
        );
        handler.processYieldForLenders(
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            115792089237316195423570985008687907853269984665640564039457584007913129639934
        );
        handler.processYieldForLenders(
            1268561228261529728614163060291832384564902120752055920667486,
            3
        );
        handler.refreshCredit(
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            0
        );
        handler.drawdown(
            42386602820456485836174153604822831428264533314673371896439,
            240913102147,
            3
        );
        handler.makePayment(19615076033, 160243692824, 9727778102912);
        handler.disburse(
            69864780130920761207658305981970087787,
            4360118702345233994044192325882,
            115792089237316195423570985008687907853269984665640564039457584007913129639935
        );
        handler.deposit(
            19959107888628031453835439298095185132555517324170362100238386682694668910592,
            80564854815,
            49481348888821471073599999575453234739684463595567482465168104918255872770048,
            30423094530776731103136002867200
        );
        handler.deposit(
            1705999710310,
            690991945221,
            7231125504,
            22707858064020014833263393105270024864682788176116601170829854880087448485888
        );
        handler.deposit(
            47686135620339929650580286818311263903644659543529227071910419057508005969920,
            25935365983,
            25867022166723788740686732833450359658164776016726625978687660847038327685120,
            34074150866979154454380422018338034493888
        );
        handler.processYieldForLenders(
            66273300980022294409193305815659,
            874737881939132867071693501173569528289205065036113342155054281
        );
        handler.addRedemptionRequest(
            1468871145562,
            11106076657849,
            1027794398110,
            31079268863996216384445538971527541863997223421898523578754
        );
        handler.deposit(
            3,
            115792089237316195423570985008687907853269984665640564039457584007913129639933,
            3,
            48944478330842060318076810825395757376366006863646132250165207208733945
        );
        handler.disburse(
            1705999727564,
            369166094157274069797519852577183672307435,
            34585382314460395541881037369824160358478
        );
        handler.addRedemptionRequest(
            40122653051913337917558146142561809866274860629971,
            62686085192475,
            3,
            2
        );
        handler.processYieldForLenders(800924402837, 1705999690348);
        handler.addRedemptionRequest(
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            0,
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            3
        );
        handler.deposit(
            205902660880,
            5813539891451931970975404301935401320058357279667520142311426,
            21810306743343862965069975466850831013780099402757000555213166705658942547045,
            832238386
        );
        handler.refreshCredit(
            10703657385265749558365913602348903903739991582701071477343922391962,
            34602906316357950585127327793470189518750
        );
        handler.addRedemptionRequest(
            30154168850,
            1170087873972,
            34396255443740771365740143079591766439013,
            10707996117985248832109876899998225042766801530784285018313709133168
        );
        handler.cancelRedemptionRequest(
            487097531703325607027608230561813479965689827752357538763,
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            0,
            115792089237316195423570985008687907853269984665640564039457584007913129639933
        );
        handler.drawdown(
            586309193307239311926191699324945563276545,
            567495649232454689841467241895565736513,
            792
        );
        handler.deposit(
            3,
            115792089237316195423570985008687907853269984665640564039457584007913129639934,
            1,
            115792089237316195423570985008687907853269984665640564039457584007913129639934
        );
        handler.disburse(
            1132179894,
            1705999708346,
            19959107888628031453835439298095185132555517324170061106080109046819119431680
        );
        handler.addRedemptionRequest(
            146878027157,
            155061966442829536895138402513897160,
            10256592980144464059331902487207866779757403238222138552507,
            3
        );
        handler.drawdown(280797864116684635771132269691316806507839666064778003, 0, 0);
        handler.cancelRedemptionRequest(
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            0,
            3,
            2
        );
        handler.deposit(
            0,
            115792089237316195423570985008687907853269984665640564039457584007913129639935,
            0,
            189145047777773989
        );
    }

    function invariant_displayCallsLog() public view {
        handler.displayCallsLog();
    }

    function _assert_Tranche_A() internal {
        assertGe(
            seniorTranche.totalAssets(),
            seniorTranche.totalSupply(),
            "Senior Tranche Invariant A"
        );
        assertGe(
            juniorTranche.totalAssets(),
            juniorTranche.totalSupply(),
            "Junior Tranche Invariant A"
        );
    }

    function _assert_Tranche_B() internal {
        assertEq(
            seniorTranche.convertToAssets(seniorTranche.totalSupply()),
            seniorTranche.totalAssets(),
            "Senior Invariant B"
        );
        assertEq(
            juniorTranche.convertToAssets(juniorTranche.totalSupply()),
            juniorTranche.totalAssets(),
            "Junior Invariant B"
        );
    }

    function _assert_Tranche_C() internal {
        assertEq(
            seniorTranche.convertToShares(seniorTranche.totalAssets()),
            seniorTranche.totalSupply(),
            "Senior Invariant C"
        );
        assertEq(
            juniorTranche.convertToShares(juniorTranche.totalAssets()),
            juniorTranche.totalSupply(),
            "Junior Invariant C"
        );
    }

    function _assert_Tranche_D_E_F() internal {
        uint256 allSeniorBalanceOf = seniorInitialShares +
            seniorTranche.balanceOf(address(seniorTranche));
        uint256 allSeniorAssetsOf = seniorTranche.convertToAssets(allSeniorBalanceOf);
        uint256 allJuniorBalanceOf = juniorInitialShares +
            juniorTranche.balanceOf(address(juniorTranche));
        uint256 allJuniorAssetsOf = juniorTranche.convertToAssets(allJuniorBalanceOf);

        uint256 len = lenders.length;
        for (uint256 i = 0; i < len; ++i) {
            address lender = lenders[i];
            uint256 balanceOf = seniorTranche.balanceOf(lender);
            allSeniorBalanceOf += balanceOf;
            uint256 assetsOf;
            if (balanceOf > 0) {
                assetsOf = seniorTranche.totalAssetsOf(lender);
                assertGe(
                    assetsOf,
                    balanceOf,
                    string.concat(
                        "Senior Tranche Invariant D - ",
                        vm.toString(i),
                        ", ",
                        vm.toString(lender)
                    )
                );
                allSeniorAssetsOf += assetsOf;
            }
            balanceOf = juniorTranche.balanceOf(lender);
            allJuniorBalanceOf += balanceOf;
            if (balanceOf > 0) {
                assetsOf = juniorTranche.totalAssetsOf(lender);
                assertGe(
                    assetsOf,
                    balanceOf,
                    string.concat(
                        "Junior Tranche Invariant D - ",
                        vm.toString(i),
                        ", ",
                        vm.toString(lender)
                    )
                );
                allJuniorAssetsOf += assetsOf;
            }
        }

        assertEq(seniorTranche.totalSupply(), allSeniorBalanceOf, "Senior Invariant E");
        assertEq(juniorTranche.totalSupply(), allJuniorBalanceOf, "Junior Invariant E");
        assertApproxEqAbs(
            seniorTranche.totalAssets(),
            allSeniorAssetsOf,
            len,
            "Senior Invariant F"
        );
        assertApproxEqAbs(
            juniorTranche.totalAssets(),
            allJuniorAssetsOf,
            len,
            "Junior Invariant F"
        );
    }

    function _assert_Tranche_J() internal {
        assertGe(
            poolSafe.totalBalance(),
            poolSafe.unprocessedTrancheProfit(seniorTranche) +
                poolSafe.unprocessedTrancheProfit(juniorTranche),
            "Tranche Invariant J"
        );
    }
}
