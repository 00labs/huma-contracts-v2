// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "./DealStructs.sol";
import {IDealLogic} from "./interfaces/IDealLogic.sol";

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

struct CreditLimit {
    address borrower; // loan borrower address
    uint96 creditLimit; // the max borrowed amount
}

contract BaseCredit {
    IDealLogic public dealLogic;

    mapping(bytes32 => CreditLimit) public creditLimits;
    mapping(bytes32 => DealConfig) public dealConfigs;
    mapping(bytes32 => DealInfo) public deals;

    bytes32[] public activeDealsHash;

    uint256 public unprocessedProfit;

    function _approve(
        bytes32 creditHash,
        address borrower,
        uint256 creditLimit,
        DealConfig calldata dealConfig
    ) internal {
        // only EA

        CreditLimit memory cl = creditLimits[creditHash];
        if (cl.borrower != address(0)) revert();

        _createDealConfig(creditHash, dealConfig);
    }

    /**
     * @notice Creates loan config data
     * @param dealHash a unique hash for the loan
     * @param dealConfig the schedule and payment parameters for this loan
     */
    function _createDealConfig(bytes32 dealHash, DealConfig memory dealConfig) internal {
        dealConfigs[dealHash] = dealConfig;
    }

    function drawdown(bytes32 creditHash, uint256 borrowAmount) public virtual {
        // only borrower or approved address borrower

        CreditLimit memory cl = creditLimits[creditHash];

        _borrowFromDeal(creditHash, borrowAmount);

        // transfer borrowAmount to borrower
    }

    /**
     * @notice Updates loan data when borrowers borrow
     * @param dealHash a unique hash for the loan
     * @param amount borrowed amount
     */
    function _borrowFromDeal(bytes32 dealHash, uint256 amount) internal {
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

            unprocessedProfit += accruedInterest;

            // update the drawdown amount
            di.checkPoint.totalPrincipal += uint96(amount);
        }

        // store loan data
        deals[dealHash] = di;
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

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        CreditLimit memory cl = creditLimits[creditHash];

        _payToDeal(creditHash, amount);

        // transfer amount from msg.sender
    }

    /**
     * @notice Updates loan data when borrowers pay
     * @param dealHash a unique hash for the loan
     * @param amount paid amount
     */
    function _payToDeal(bytes32 dealHash, uint256 amount) internal {
        // check parameters & permission

        DealInfo memory di = deals[dealHash];
        uint256 accruedInterest;

        // update loan data(interest, principal) to current time
        (di, accruedInterest) = _refreshDeal(dealHash, di);

        unprocessedProfit += accruedInterest;

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

    function updateProfit() external returns (uint256 profit) {
        profit = unprocessedProfit;

        // Iterate all active loans to get the total profit
        for (uint256 i; i < activeDealsHash.length; i++) {
            bytes32 hash = activeDealsHash[i];
            (DealInfo memory di, uint256 accruedInterest) = _refreshDeal(hash, deals[hash]);
            deals[hash] = di;
            profit += accruedInterest;
        }

        unprocessedProfit = 0;
    }

    function calculateProfit() external view returns (uint256 profit) {
        profit = unprocessedProfit;

        // Iterates all active loans to get the total profit
        for (uint256 i; i < activeDealsHash.length; i++) {
            bytes32 hash = activeDealsHash[i];
            (, uint256 accruedInterest) = _refreshDeal(hash, deals[hash]);
            profit += accruedInterest;
        }
    }
}
