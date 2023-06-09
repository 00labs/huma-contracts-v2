// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "./DealStructs.sol";
import {IDealPortfolioPool} from "./interfaces/IDealPortfolioPool.sol";
import {IDealLogic} from "./interfaces/IDealLogic.sol";
import {IFeeManager} from "./interfaces/IFeeManager.sol";
import {ITrancheLogic} from "./interfaces/ITrancheLogic.sol";

struct DealCheckPoint {
    uint96 totalAccruedInterest; // total accrued interest from tha loan start
    uint96 totalAccruedPrincipal; // total principal to be repaid from tha loan start
    uint64 lastUpdatedTime; // the updated timestamp of totalAccruedInterest and totalAccruedPrincipal
    uint96 totalPrincipal;
    uint96 totalPaidInterest;
    uint96 totalPaidPrincipal;
}

struct DealInfo {
    uint64 startTime; // loan start timestamp
    DealState state;
    DealCheckPoint checkPoint;
}

enum DealState {
    Deleted,
    Requested,
    Approved,
    GoodStanding,
    Delayed,
    Defaulted
}

struct FeeInfo {
    uint96 protocolFee;
    uint96 ownerFee;
}

struct TranchesInfo {
    uint96 seniorTotalAssets; // total assets of senior tranche
    uint96 juniorTotalAssets; // total assets of junior tranche
    uint256 lastUpdatedTime; // the updated timestamp of seniorTotalAssets and juniorTotalAssets
}

contract DealPortfolioPool is IDealPortfolioPool {
    uint256 public constant SENIOR_TRANCHE_INDEX = 1;
    uint256 public constant JUNIOR_TRANCHE_INDEX = 2;

    IDealLogic public dealLogic;
    IFeeManager public feeManager;
    ITrancheLogic public trancheLogic;

    mapping(bytes32 => DealConfig) public dealConfigs;
    mapping(bytes32 => DealInfo) public deals;
    bytes32[] public activeDealsHash;
    FeeInfo public feeInfo;
    TranchesInfo public tranches;

    function createDealConfig(bytes32 dealHash, DealConfig memory dealConfig) external override {
        // check parameters and permission

        dealConfigs[dealHash] = dealConfig;
    }

    function borrowFromDeal(bytes32 dealHash, uint256 amount) external {
        // check parameters & permission

        DealInfo memory di = deals[dealHash];

        if (di.startTime == 0) {
            // the first drawdown

            // initialize a loan
            di.startTime = uint64(block.timestamp);
            di.checkPoint.totalPrincipal = uint96(amount);
            di.state = DealState.GoodStanding;
            di.checkPoint.lastUpdatedTime = uint64(block.timestamp);
        } else {
            // drawdown for an existing loan

            uint256 accruedInterest;

            // update loan data(interest, principal) to current time
            (di, accruedInterest) = _refreshDeal(dealHash, di);

            // distribute new profit
            if (accruedInterest > 0) {
                _processProfit(accruedInterest);
            }

            // update the drawdown amount
            di.checkPoint.totalPrincipal += uint96(amount);
        }

        // store loan data
        deals[dealHash] = di;
    }

    function payToDeal(bytes32 dealHash, uint256 amount) external {
        // check parameters & permission

        DealInfo memory di = deals[dealHash];
        uint256 accruedInterest;

        // update loan data(interest, principal) to current time
        (di, accruedInterest) = _refreshDeal(dealHash, di);

        // distribute new profit
        if (accruedInterest > 0) {
            _processProfit(accruedInterest);
        }

        // update paid interest
        uint256 interestPart = di.checkPoint.totalAccruedInterest -
            di.checkPoint.totalPaidInterest;
        interestPart = amount > interestPart ? interestPart : amount;
        di.checkPoint.totalPaidInterest += uint96(interestPart);

        // update paid principal
        if (amount > interestPart) {
            di.checkPoint.totalPaidPrincipal += uint96(amount - interestPart);
        }
    }

    function trancheTotalAssets(uint256 index) external view returns (uint256) {
        if (block.timestamp > tranches.lastUpdatedTime) {
            // need to update tranche assets

            // update tranche assets to current time
            uint96[2] memory assets = _calculateLatestTranches();

            return index == SENIOR_TRANCHE_INDEX ? assets[0] : assets[1];
        } else {
            return
                index == SENIOR_TRANCHE_INDEX
                    ? tranches.seniorTotalAssets
                    : tranches.juniorTotalAssets;
        }
    }

    function updatePool() external returns (uint96[2] memory) {
        // check permission

        uint256 profit;

        // Iterates all active loans to get the total profit
        for (uint256 i; i < activeDealsHash.length; i++) {
            bytes32 hash = activeDealsHash[i];
            (DealInfo memory di, uint256 accruedInterest) = _refreshDeal(hash, deals[hash]);
            deals[hash] = di;
            profit += accruedInterest;
        }

        // distribute profit
        if (profit > 0) {
            _processProfit(profit);
        }

        return [tranches.seniorTotalAssets, tranches.juniorTotalAssets];
    }

    function _refreshDeal(
        bytes32 dealHash,
        DealInfo memory di
    ) internal view returns (DealInfo memory, uint256) {
        (uint256 accruedInterest, uint256 accruedPrincipal) = dealLogic
            .calculateInterestAndPincipal(
                di.checkPoint.totalPrincipal - di.checkPoint.totalPaidPrincipal,
                di.startTime,
                di.checkPoint.lastUpdatedTime,
                dealConfigs[dealHash]
            );
        di.checkPoint.totalAccruedInterest += uint96(accruedInterest);
        di.checkPoint.totalAccruedPrincipal += uint96(accruedPrincipal);
        di.checkPoint.lastUpdatedTime = uint64(block.timestamp);

        return (di, accruedInterest);
    }

    function _calculateLatestTranches() internal view returns (uint96[2] memory trancheAssets) {
        uint256 profit;
        // Iterates all active loans to get the total profit
        for (uint256 i; i < activeDealsHash.length; i++) {
            bytes32 hash = activeDealsHash[i];
            (, uint256 accruedInterest) = _refreshDeal(hash, deals[hash]);
            profit += accruedInterest;
        }

        if (profit > 0) {
            // distribute profit
            (, trancheAssets) = _calculateProfitDistribution(profit);
        } else {
            trancheAssets = [tranches.seniorTotalAssets, tranches.juniorTotalAssets];
        }
    }

    function _calculateProfitDistribution(
        uint256 profit
    ) internal view returns (uint96[] memory fees, uint96[2] memory assets) {
        // calculate fees
        uint256[] memory feeParams = new uint256[](3);
        feeParams[0] = profit;
        (uint256 protocolFee, uint256 ownerFee, uint256 remaining) = feeManager.calculateFees(
            feeParams
        );
        fees[0] = uint96(protocolFee);
        fees[1] = uint96(ownerFee);

        if (remaining > 0) {
            // calculate tranches assets after profit distribution
            assets = trancheLogic.distributeProfit(
                remaining,
                [tranches.seniorTotalAssets, tranches.juniorTotalAssets],
                tranches.lastUpdatedTime
            );
        }
    }

    function _processProfit(uint256 profit) internal {
        // calculate fees and tranches assets
        (uint96[] memory fees, uint96[2] memory assets) = _calculateProfitDistribution(profit);

        // store fees info
        feeInfo.protocolFee += fees[0];
        feeInfo.ownerFee += fees[1];

        // store tranches info
        tranches.seniorTotalAssets = assets[0];
        tranches.juniorTotalAssets = assets[1];
        tranches.lastUpdatedTime = block.timestamp;
    }
}
