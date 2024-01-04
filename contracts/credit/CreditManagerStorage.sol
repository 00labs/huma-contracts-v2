// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {HumaConfig} from "../HumaConfig.sol";
import {CreditConfig} from "./CreditStructs.sol";
import {ICredit} from "./interfaces/ICredit.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {ICreditDueManager} from "./utils/interfaces/ICreditDueManager.sol";

contract CreditManagerStorage {
    HumaConfig public humaConfig;
    ICredit public credit;
    ICalendar public calendar;
    ICreditDueManager public dueManager;

    /// mapping from credit id to the credit config
    mapping(bytes32 => CreditConfig) internal _creditConfigMap;

    // This mapping is used to maintain the relationship between credit and borrower
    mapping(bytes32 => address) internal _creditBorrowerMap;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
