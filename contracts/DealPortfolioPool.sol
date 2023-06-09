// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "./DealStructs.sol";
import {IDealPortfolioPool} from "./interfaces/IDealPortfolioPool.sol";
import {IDealLogic} from "./interfaces/IDealLogic.sol";
import {IFeeManager} from "./interfaces/IFeeManager.sol";
import {ITrancheLogic} from "./interfaces/ITrancheLogic.sol";

struct DealCheckPoint {
    uint96 totalAccruedInterest;
    uint96 totalAccruedPrincipal;
    uint64 lastUpdatedTime;
    uint96 totalPrincipal;
    uint96 totalPaidInterest;
    uint96 totalPaidPrincipal;
}

struct DealInfo {
    uint64 startTime;
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
    uint96[] totalAssets;
    uint256 lastUpdatedTime;
}

contract DealPortfolioPool is IDealPortfolioPool {
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
            di.startTime = uint64(block.timestamp);
            di.checkPoint.totalPrincipal = uint96(amount);
            di.state = DealState.GoodStanding;
            di.checkPoint.lastUpdatedTime = uint64(block.timestamp);
        } else {
            uint256 accruedInterest;
            (di, accruedInterest) = _refreshDeal(dealHash, di);
            if (accruedInterest > 0) {
                _processProfit(accruedInterest);
            }
            di.checkPoint.totalPrincipal += uint96(amount);
        }
        deals[dealHash] = di;
    }

    function payToDeal(bytes32 dealHash, uint256 amount) external {
        // check parameters & permission

        DealInfo memory di = deals[dealHash];
        uint256 accruedInterest;
        (di, accruedInterest) = _refreshDeal(dealHash, di);
        if (accruedInterest > 0) {
            _processProfit(accruedInterest);
        }

        uint256 interestPart = di.checkPoint.totalAccruedInterest -
            di.checkPoint.totalPaidInterest;
        interestPart = amount > interestPart ? interestPart : amount;
        di.checkPoint.totalPaidInterest += uint96(interestPart);
        if (amount > interestPart) {
            di.checkPoint.totalPaidPrincipal += uint96(amount - interestPart);
        }
    }

    function trancheTotalAssets(uint256 index) external view returns (uint256) {
        if (block.timestamp > tranches.lastUpdatedTime) {
            return _calculateLatestTranches()[index];
        } else {
            return tranches.totalAssets[index];
        }
    }

    function updatePool() external returns (uint96[] memory) {
        // check permission

        uint256 profit;
        for (uint256 i; i < activeDealsHash.length; i++) {
            bytes32 hash = activeDealsHash[i];
            (DealInfo memory di, uint256 accruedInterest) = _refreshDeal(hash, deals[hash]);
            deals[hash] = di;
            profit += accruedInterest;
        }
        if (profit > 0) {
            _processProfit(profit);
        }

        return tranches.totalAssets;
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

    function _calculateLatestTranches() internal view returns (uint96[] memory trancheAssets) {
        uint256 profit;
        for (uint256 i; i < activeDealsHash.length; i++) {
            bytes32 hash = activeDealsHash[i];
            (, uint256 accruedInterest) = _refreshDeal(hash, deals[hash]);
            profit += accruedInterest;
        }
        if (profit > 0) {
            (, trancheAssets) = _calculateProfitDistribution(profit);
        } else {
            trancheAssets = tranches.totalAssets;
        }
    }

    function _calculateProfitDistribution(
        uint256 profit
    ) internal view returns (uint96[] memory fees, uint96[] memory assets) {
        uint256[] memory feeParams = new uint256[](3);
        feeParams[0] = profit;
        (uint256 protocolFee, uint256 ownerFee, uint256 remaining) = feeManager.calculateFees(
            feeParams
        );
        fees[0] = uint96(protocolFee);
        fees[1] = uint96(ownerFee);
        if (remaining > 0) {
            assets = trancheLogic.distributeProfit(
                remaining,
                tranches.lastUpdatedTime,
                tranches.totalAssets
            );
        }
    }

    function _processProfit(uint256 profit) internal {
        (uint96[] memory fees, uint96[] memory assets) = _calculateProfitDistribution(profit);
        feeInfo.protocolFee += fees[0];
        feeInfo.ownerFee += fees[1];
        if (assets.length > 0) {
            tranches.totalAssets = assets;
        }
        tranches.lastUpdatedTime = block.timestamp;
    }
}
